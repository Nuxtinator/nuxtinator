<script setup lang="ts">
// Manage a portfolio's section definitions: every section (built-in and
// custom) with reorder and remove actions, rename for custom sections, plus
// controls to add a missing built-in or a new custom section. `list` off shows
// only the add controls, for pages that already render the sections themselves.

const props = withDefaults(defineProps<{ slug: string, list?: boolean }>(), { list: true })
const emit = defineEmits(['changed'])

interface SectionDef {
  id: string
  key: string
  title: string
  description: string
  order: number
  is_custom: boolean
}

const { hasPermission } = usePermissions()
const canManage = computed(() => hasPermission('context.section.custom'))

const { data, refresh } = await useAsyncData(
  () => `context-manage-sections-${props.slug}`,
  () => $fetch<{ sections: SectionDef[], missing_builtins: Array<{ key: string, title: string }> }, string>(`/api/context/portfolios/${props.slug}/sections`)
)
const sections = computed(() => data.value?.sections ?? [])
const missingBuiltins = computed(() =>
  (data.value?.missing_builtins ?? []).map(s => ({ label: s.title, value: s.key }))
)

// Local copy the reorder controls mutate, so a drag or a move shows
// immediately and rolls back if the save fails.
const ordered = ref<SectionDef[]>([])
watch(sections, next => (ordered.value = [...next]), { immediate: true })

const builtinToAdd = ref<string | undefined>(undefined)
const form = reactive({ title: '', description: '' })
const adding = ref(false)
const error = ref<string | null>(null)

const removeTarget = ref<SectionDef | null>(null)
const removeOpen = ref(false)
const removing = ref(false)

const editKey = ref<string | null>(null)
const editForm = reactive({ title: '', description: '' })
const savingEdit = ref(false)

const dragKey = ref<string | null>(null)
const dragOverKey = ref<string | null>(null)
const savingOrder = ref(false)

async function afterChange() {
  await refresh()
  await refreshNuxtData([`context-sidebar-sections-${props.slug}`, `context-sections-${props.slug}`])
  emit('changed')
}

async function add(body: { key: string } | { title: string, description?: string }) {
  adding.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${props.slug}/sections`, { method: 'POST', body })
    await afterChange()
    return true
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Add failed.'
    return false
  } finally {
    adding.value = false
  }
}

async function addBuiltin() {
  if (!builtinToAdd.value) return
  if (await add({ key: builtinToAdd.value })) builtinToAdd.value = undefined
}

async function addCustom() {
  if (!form.title.trim()) return
  if (await add({ title: form.title.trim(), description: form.description.trim() || undefined })) {
    form.title = ''
    form.description = ''
  }
}

async function persistOrder(next: SectionDef[]) {
  const previous = ordered.value
  ordered.value = next
  savingOrder.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${props.slug}/section-order`, {
      method: 'PUT',
      body: { keys: next.map(s => s.key) }
    })
    await afterChange()
  } catch (e) {
    ordered.value = previous
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Reorder failed.'
  } finally {
    savingOrder.value = false
  }
}

function reordered(from: number, to: number): SectionDef[] {
  const next = [...ordered.value]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

function move(index: number, delta: number) {
  const to = index + delta
  if (to < 0 || to >= ordered.value.length) return
  persistOrder(reordered(index, to))
}

function onDragStart(key: string, event: DragEvent) {
  dragKey.value = key
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }
}

function onDragEnd() {
  dragKey.value = null
  dragOverKey.value = null
}

function onDrop(overKey: string) {
  const from = ordered.value.findIndex(s => s.key === dragKey.value)
  const to = ordered.value.findIndex(s => s.key === overKey)
  onDragEnd()
  if (from < 0 || to < 0 || from === to) return
  persistOrder(reordered(from, to))
}

function startEdit(section: SectionDef) {
  editKey.value = section.key
  editForm.title = section.title
  editForm.description = section.description
}

async function saveEdit() {
  const key = editKey.value
  if (!key || !editForm.title.trim()) return
  savingEdit.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${props.slug}/sections/${key}`, {
      method: 'PATCH',
      body: { title: editForm.title.trim(), description: editForm.description.trim() }
    })
    editKey.value = null
    await afterChange()
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Rename failed.'
  } finally {
    savingEdit.value = false
  }
}

function askRemove(section: SectionDef) {
  removeTarget.value = section
  removeOpen.value = true
}

async function remove() {
  const target = removeTarget.value
  if (!target) return
  removing.value = true
  error.value = null
  try {
    await $fetch(`/api/context/portfolios/${props.slug}/sections/${target.key}`, { method: 'DELETE' })
    removeOpen.value = false
    await afterChange()
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Remove failed.'
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <ul v-if="list && ordered.length" class="divide-y divide-(--ui-border) border border-(--ui-border) rounded">
      <li
        v-for="(s, i) in ordered"
        :key="s.key"
        class="flex items-center gap-2 p-3 transition-colors"
        :class="{
          'opacity-40': dragKey === s.key,
          'bg-(--ui-bg-elevated)': dragOverKey === s.key && dragKey !== null && dragKey !== s.key
        }"
        :draggable="canManage && !savingOrder && editKey === null"
        @dragstart="onDragStart(s.key, $event)"
        @dragend="onDragEnd"
        @dragover.prevent="dragOverKey = s.key"
        @drop.prevent="onDrop(s.key)"
      >
        <UIcon
          v-if="canManage"
          name="i-lucide-grip-vertical"
          class="shrink-0 size-4 text-(--ui-text-dimmed) cursor-grab"
        />
        <form
          v-if="editKey === s.key"
          class="min-w-0 flex-1 flex flex-col gap-2 sm:flex-row sm:items-center"
          @submit.prevent="saveEdit"
        >
          <UInput v-model="editForm.title" placeholder="Title" aria-label="Section title" class="flex-1" autofocus />
          <UInput v-model="editForm.description" placeholder="Description (optional)" aria-label="Section description" class="flex-1" />
          <div class="flex gap-1">
            <UButton type="submit" size="sm" :loading="savingEdit" :disabled="!editForm.title.trim()">
              Save
            </UButton>
            <UButton size="sm" variant="ghost" color="neutral" :disabled="savingEdit" @click="editKey = null">
              Cancel
            </UButton>
          </div>
        </form>
        <div v-else class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium">{{ s.title }}</span>
            <UBadge v-if="s.is_custom" variant="subtle" color="neutral" size="xs">
              Custom
            </UBadge>
          </div>
          <div class="text-sm text-(--ui-text-muted)">
            <code class="text-xs">{{ s.key }}</code>
            <span v-if="s.description"> · {{ s.description }}</span>
          </div>
        </div>
        <template v-if="canManage && editKey !== s.key">
          <UButton
            v-if="s.is_custom"
            variant="ghost"
            color="neutral"
            icon="i-lucide-pencil"
            size="sm"
            :aria-label="`Rename ${s.title}`"
            @click="startEdit(s)"
          />
          <UButton
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-up"
            size="sm"
            :disabled="i === 0 || savingOrder"
            :aria-label="`Move ${s.title} up`"
            @click="move(i, -1)"
          />
          <UButton
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-down"
            size="sm"
            :disabled="i === ordered.length - 1 || savingOrder"
            :aria-label="`Move ${s.title} down`"
            @click="move(i, 1)"
          />
          <UButton
            variant="ghost"
            color="error"
            icon="i-lucide-trash"
            size="sm"
            :aria-label="`Remove ${s.title}`"
            @click="askRemove(s)"
          />
        </template>
      </li>
    </ul>
    <p v-else-if="list" class="text-sm text-(--ui-text-muted)">
      This portfolio has no sections yet.
    </p>

    <template v-if="canManage">
      <form v-if="missingBuiltins.length" class="flex flex-col gap-2 sm:flex-row sm:items-end" @submit.prevent="addBuiltin">
        <UFormField label="Add a built-in section" class="flex-1">
          <USelect v-model="builtinToAdd" :items="missingBuiltins" placeholder="Choose a section" class="w-full" />
        </UFormField>
        <UButton type="submit" variant="outline" :loading="adding" :disabled="!builtinToAdd">
          Add
        </UButton>
      </form>

      <form class="flex flex-col gap-2 sm:flex-row sm:items-end" @submit.prevent="addCustom">
        <UFormField label="Add a custom section" class="flex-1">
          <UInput v-model="form.title" placeholder="e.g. Roadmap" class="w-full" />
        </UFormField>
        <UFormField label="Description (optional)" class="flex-1">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>
        <UButton type="submit" :loading="adding">
          Add
        </UButton>
      </form>
    </template>

    <p v-if="error" class="text-(--ui-error) text-sm">
      {{ error }}
    </p>

    <ContextConfirmModal
      v-model:open="removeOpen"
      :title="`Remove ${removeTarget?.title ?? 'section'}?`"
      description="Its content is kept and comes back if you add the section again."
      confirm-label="Remove"
      :loading="removing"
      @confirm="remove"
    />
  </div>
</template>
