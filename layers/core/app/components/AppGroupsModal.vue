<script setup lang="ts">
// Picks the groups an app is limited to. `endpoint` answers GET with
// `{ groups: [{ id, name, member_count, archived, selected }] }` and takes
// PUT `{ groupIds }`. No group picked leaves the app open to everyone who
// could open it before.
interface AppGroupOption {
  id: string
  name: string
  member_count: number
  archived: boolean
  selected: boolean
}

const props = defineProps<{
  endpoint: string | null
  title: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()

const toast = useToast()
const groups = ref<AppGroupOption[]>([])
const picked = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)

watch([open, () => props.endpoint], async ([isOpen, endpoint]) => {
  if (!isOpen || !endpoint) return
  loading.value = true
  try {
    const res = await $fetch<{ groups: AppGroupOption[] }, string>(endpoint)
    groups.value = res.groups
    picked.value = res.groups.filter(g => g.selected).map(g => g.id)
  } finally {
    loading.value = false
  }
}, { immediate: true })

const toggle = (id: string, on: boolean) => {
  picked.value = on ? [...picked.value, id] : picked.value.filter(g => g !== id)
}

const onSave = async () => {
  if (!props.endpoint) return
  saving.value = true
  try {
    await $fetch(props.endpoint, { method: 'PUT', body: { groupIds: picked.value } })
    open.value = false
    emit('saved')
  } catch (err: unknown) {
    toast.add({ title: 'Save failed', description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
  >
    <template #body>
      <div class="space-y-3">
        <div
          v-if="loading && groups.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          Loading...
        </div>
        <div
          v-else-if="groups.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          No groups yet.
        </div>
        <ul
          v-else
          class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
        >
          <li
            v-for="g in groups"
            :key="g.id"
            class="flex items-center justify-between gap-3 p-3"
          >
            <UCheckbox
              :model-value="picked.includes(g.id)"
              :label="g.archived ? `${g.name} (archived)` : g.name"
              :disabled="g.archived && !picked.includes(g.id)"
              @update:model-value="toggle(g.id, $event === true)"
            />
            <span class="text-xs text-(--ui-text-muted) shrink-0">
              {{ g.member_count }} {{ g.member_count === 1 ? 'member' : 'members' }}
            </span>
          </li>
        </ul>
        <p class="text-xs text-(--ui-text-muted)">
          {{ picked.length === 0 ? 'Open to everyone.' : 'Open only to members of the picked groups.' }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          variant="ghost"
          color="neutral"
          @click="open = false"
        >
          Cancel
        </UButton>
        <UButton
          :loading="saving"
          @click="onSave"
        >
          Save
        </UButton>
      </div>
    </template>
  </UModal>
</template>
