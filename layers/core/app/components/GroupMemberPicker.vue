<script setup lang="ts">
// Everyone who could be in a group, each with a checkbox (checked = in it).
// Lists what `searchUsers('')` returns; the filter narrows the list. People
// already checked stay listed while they match the filter.
import type { GroupsManagerUser } from './GroupsManager.vue'

const props = defineProps<{
  searchUsers: (q: string) => Promise<GroupsManagerUser[]>
  selected: GroupsManagerUser[]
  busyId?: string | null
}>()
const emit = defineEmits<{ toggle: [user: GroupsManagerUser, on: boolean] }>()

const filter = ref('')
const results = ref<GroupsManagerUser[]>([])
const loading = ref(false)

const load = async () => {
  loading.value = true
  try {
    results.value = await props.searchUsers(filter.value.trim())
  } finally {
    loading.value = false
  }
}
onMounted(load)

let timer: ReturnType<typeof setTimeout> | null = null
watch(filter, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 250)
})

const nameOf = (u: GroupsManagerUser) => u.display_name || u.email || 'Unnamed user'
const selectedIds = computed(() => new Set(props.selected.map(u => u.id)))

const people = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const matches = (u: GroupsManagerUser) => !needle
    || nameOf(u).toLowerCase().includes(needle)
    || (u.email ?? '').toLowerCase().includes(needle)
  const byId = new Map<string, GroupsManagerUser>()
  for (const u of props.selected) if (matches(u)) byId.set(u.id, u)
  for (const u of results.value) if (!byId.has(u.id)) byId.set(u.id, u)
  return [...byId.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
})
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <UInput
        v-model="filter"
        icon="i-lucide-search"
        placeholder="Filter by name or email"
        class="flex-1"
      />
      <span class="text-xs text-(--ui-text-muted) shrink-0">
        {{ selected.length }} selected
      </span>
    </div>
    <div
      v-if="loading && people.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>
    <div
      v-else-if="people.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      No one found.
    </div>
    <ul
      v-else
      class="max-h-80 overflow-y-auto divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
    >
      <CheckboxRow
        v-for="u in people"
        :key="u.id"
        :checked="selectedIds.has(u.id)"
        :label="nameOf(u)"
        :disabled="busyId === u.id"
        @toggle="emit('toggle', u, $event)"
      >
        <UAvatar
          :src="u.avatar || undefined"
          :alt="nameOf(u)"
          size="sm"
        />
        <div class="min-w-0">
          <div class="text-sm font-medium truncate">
            {{ nameOf(u) }}
          </div>
          <div
            v-if="u.email && u.email !== nameOf(u)"
            class="text-xs text-(--ui-text-muted) truncate"
          >
            {{ u.email }}
          </div>
        </div>
      </CheckboxRow>
    </ul>
  </div>
</template>
