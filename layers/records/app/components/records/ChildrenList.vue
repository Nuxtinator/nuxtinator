<script setup lang="ts">
// The records directly under one record (a task's subtasks) as a list in the
// detail view's main column: a done tick box, the name (a link to that
// record), who it's assigned to, and a line to add another. The heading
// shows how many are done, then any controls other layers registered for it
// (a link to the board of them). Closed ones are left out until asked for,
// and a long list shows its first rows with a control for the rest. The tick box needs a type with exactly one closed
// status and no closing reason; other types show each record's status
// instead. Lists what the caller may see, oldest first.
import { getRecordsChildrenActions } from '#records'
import type { RecordListItem } from '../../composables/useRecordsList'
import type { RecordsFieldSetting } from '../../utils/field-kinds'

const props = defineProps<{
  typeKey: string
  recordId: string
  /** The children side of the type's hierarchy; its label heads the list. */
  field: RecordsFieldSetting
  /** Key of the parent side, which each child points at this record with. */
  parentKey: string
  statusField: RecordsFieldSetting | null
  /** The type asks why a record was closed, so a tick can't close one. */
  needsReason: boolean
  canAdd: boolean
}>()

const emit = defineEmits<{
  /** A child was added or its status changed. */
  changed: []
}>()

const toast = useToast()
const typePath = useRecordsTypePath()
const { byId, ensureUserIds } = useRecordsUsers()

const items = ref<RecordListItem[]>([])

// Closed records stay out of the list, and it stops after this many rows,
// until the person asks for the rest.
const LIMIT = 15
const showClosed = ref(false)
const expanded = ref(false)
const actions = computed(() => getRecordsChildrenActions(props.typeKey))

async function refresh() {
  try {
    const url: string = `/api/records/entries/${props.typeKey}`
    const res = await $fetch<{ items: RecordListItem[] }>(url, {
      query: { filters: JSON.stringify({ [props.parentKey]: props.recordId }), sort: 'created_at', dir: 'asc', limit: 100 }
    })
    items.value = res.items
    ensureUserIds(res.items.flatMap(item => item.assignedTo)).catch(() => {
      // Avatars fall back to "?" for people the directory can't name.
    })
  } catch {
    items.value = []
  }
}
watch(() => [props.typeKey, props.recordId], () => {
  showClosed.value = false
  expanded.value = false
  refresh()
}, { immediate: true })

// Ticking sets the one closed status; unticking goes back to the status
// field's default, else its first open option.
const doneStatus = computed(() => {
  const options = Object.entries(props.statusField?.options ?? {}).filter(([, o]) => !o.deleted)
  const closed = options.filter(([, o]) => o.closed)
  if (props.needsReason || closed.length !== 1) return null
  const open = options.filter(([, o]) => !o.closed)
  const preferred = props.statusField?.default
  const reopen = typeof preferred === 'string' && open.some(([key]) => key === preferred) ? preferred : open[0]?.[0]
  return reopen ? { done: closed[0]![0], reopen } : null
})
const isClosed = (item: RecordListItem) => !!item.status && !!props.statusField?.options?.[item.status]?.closed
const doneCount = computed(() => items.value.filter(isClosed).length)

const shown = computed(() => showClosed.value ? items.value : items.value.filter(item => !isClosed(item)))
const listed = computed(() => expanded.value ? shown.value : shown.value.slice(0, LIMIT))
// What the closed ones are called: the closed status's own name when there is one.
const closedWord = computed(() => {
  const closed = Object.values(props.statusField?.options ?? {}).filter(o => o.closed && !o.deleted)
  return closed.length === 1 ? closed[0]!.label.toLowerCase() : 'closed'
})

async function toggle(item: RecordListItem, done: boolean) {
  const statuses = doneStatus.value
  if (!statuses) return
  const previous = item.status
  item.status = done ? statuses.done : statuses.reopen
  try {
    const url: string = `/api/records/entries/${props.typeKey}/${item.id}`
    await $fetch(url, { method: 'PATCH', body: { fields: { status: item.status } } })
    emit('changed')
  } catch (err) {
    item.status = previous
    toast.add({ title: recordsErrorMessage(err, 'Failed to update the record'), color: 'error' })
  }
}

const draft = ref('')
const adding = ref(false)

async function add() {
  const name = draft.value.trim()
  if (!name || adding.value) return
  adding.value = true
  try {
    const url: string = `/api/records/entries/${props.typeKey}`
    await $fetch(url, { method: 'POST', body: { fields: { name, [props.parentKey]: [props.recordId] } } })
    draft.value = ''
    await refresh()
    emit('changed')
  } catch (err) {
    toast.add({ title: recordsErrorMessage(err, 'Failed to add the record'), color: 'error' })
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <section
    v-if="items.length > 0 || canAdd"
    class="space-y-2"
  >
    <div class="flex items-center gap-3 px-1">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted)">
        {{ field.label }}
      </h2>
      <template v-if="items.length > 0">
        <UProgress
          :model-value="doneCount"
          :max="items.length"
          size="xs"
          class="w-24"
        />
        <span class="text-xs text-(--ui-text-muted) tabular-nums">{{ doneCount }}/{{ items.length }}</span>
      </template>
      <div
        v-if="actions.length > 0"
        class="ml-auto flex items-center gap-1"
      >
        <component
          :is="action.component"
          v-for="action in actions"
          :key="action.id"
          :record-id="recordId"
          :record-type="typeKey"
        />
      </div>
    </div>
    <ul class="border border-(--ui-border) rounded-lg divide-y divide-(--ui-border) bg-(--ui-bg)">
      <li
        v-for="item in listed"
        :key="item.id"
        class="flex items-center gap-3 px-4 py-2"
      >
        <UCheckbox
          v-if="doneStatus"
          :model-value="isClosed(item)"
          :aria-label="isClosed(item) ? `Mark ${item.name} as not done` : `Mark ${item.name} as done`"
          @update:model-value="toggle(item, $event === true)"
        />
        <NuxtLink
          :to="typePath(typeKey, item.id)"
          class="flex-1 min-w-0 truncate text-sm hover:underline"
          :class="isClosed(item) ? 'line-through text-(--ui-text-muted)' : ''"
        >
          {{ item.name }}
        </NuxtLink>
        <UBadge
          v-if="!doneStatus && statusField && item.status"
          :color="recordsOptionColor(statusField, item.status)"
          variant="subtle"
          size="sm"
        >
          {{ recordsOptionLabel(statusField, item.status) }}
        </UBadge>
        <span
          v-if="item.assignedTo.length > 0"
          class="flex items-center gap-1 shrink-0"
        >
          <UAvatar
            v-for="id in item.assignedTo.slice(0, 3)"
            :key="id"
            v-bind="userAvatarProps({ id, name: byId.get(id)?.name, image: byId.get(id)?.avatarUrl })"
            :title="byId.get(id)?.name ?? 'Unknown user'"
            size="2xs"
          />
        </span>
      </li>
      <li
        v-if="shown.length > LIMIT || doneCount > 0"
        class="flex items-center gap-1 px-2 py-1"
      >
        <UButton
          v-if="shown.length > LIMIT"
          :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="expanded = !expanded"
        >
          {{ expanded ? 'Show fewer' : `Show ${shown.length - LIMIT} more` }}
        </UButton>
        <UButton
          v-if="doneCount > 0"
          :icon="showClosed ? 'i-lucide-eye-off' : 'i-lucide-eye'"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="showClosed = !showClosed"
        >
          {{ showClosed ? `Hide ${closedWord}` : `Show ${doneCount} ${closedWord}` }}
        </UButton>
      </li>
      <li v-if="canAdd">
        <form @submit.prevent="add">
          <UInput
            v-model="draft"
            icon="i-lucide-plus"
            variant="none"
            :placeholder="`Add to ${field.label.toLowerCase()}…`"
            :loading="adding"
            class="w-full"
            :ui="{ leading: 'ps-4', base: 'ps-11 pe-4 py-2' }"
          />
        </form>
      </li>
    </ul>
  </section>
</template>
