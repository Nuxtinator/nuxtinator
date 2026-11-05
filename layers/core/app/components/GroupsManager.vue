<script setup lang="ts">
// Create, rename, archive and delete one scope's groups and manage their
// members. The scope's routes live under `apiBase`:
//   GET    {apiBase}                         → { mode, groups }
//   POST   {apiBase}                         { name }
//   PATCH  {apiBase}/:id                     { name } | { archived }
//   DELETE {apiBase}/:id
//   GET    {apiBase}/:id/members             → { members }
//   PUT    {apiBase}/:id/members/:userId
//   DELETE {apiBase}/:id/members/:userId
//   PUT    {apiBase}/mode                    { mode }   (with `modeEditable`)
// `searchUsers` finds people who may be added; an empty query lists them.

export interface GroupsManagerUser {
  id: string
  display_name: string
  email: string | null
  avatar?: string | null
}

type GroupMode = 'audiences' | 'teams'

interface ScopeGroup {
  id: string
  name: string
  archived_at: string | null
  member_count: number
}

interface GroupMember {
  user_id: string
  display_name: string
  email: string | null
  avatar: string | null
}

const props = defineProps<{
  apiBase: string
  searchUsers: (q: string) => Promise<GroupsManagerUser[]>
  modeEditable?: boolean
}>()

const toast = useToast()
const confirmAction = useConfirm()

const { data, pending, refresh } = useAsyncData<{ mode: GroupMode, groups: ScopeGroup[] }>(
  () => `groups-${props.apiBase}`,
  () => $fetch<{ mode: GroupMode, groups: ScopeGroup[] }, string>(props.apiBase),
  { watch: [() => props.apiBase], default: () => ({ mode: 'audiences' as const, groups: [] }) }
)
const groups = computed(() => data.value?.groups ?? [])
const mode = computed<GroupMode>(() => data.value?.mode ?? 'audiences')

type UsageError = { data?: { statusMessage?: string, data?: { usage?: { appId: string, items: { title: string }[] }[] } } } | null

function errorMessage(err: unknown): string | undefined {
  const e = err as UsageError
  const used = e?.data?.data?.usage?.flatMap(u => u.items.map(i => `${i.title} (${u.appId})`)).join(', ')
  return used ? `${e?.data?.statusMessage} Used by: ${used}` : e?.data?.statusMessage
}

const MODE_ITEMS = [
  { label: 'Audiences', value: 'audiences' },
  { label: 'Teams', value: 'teams' }
]
const savingMode = ref(false)

const onSetMode = async (next: GroupMode) => {
  if (next === mode.value) return
  if (next === 'teams' && !await confirmAction({
    title: 'Run groups as teams?',
    description: 'Members will see their groups and the other people in them, and content can be limited to teams.',
    confirmLabel: 'Switch to teams'
  })) return
  savingMode.value = true
  try {
    await $fetch(`${props.apiBase}/mode`, { method: 'PUT', body: { mode: next } })
    await refresh()
  } catch (err: unknown) {
    toast.add({ title: 'Mode not changed', description: errorMessage(err), color: 'error' })
  } finally {
    savingMode.value = false
  }
}

const createOpen = ref(false)
const newName = ref('')
const newMembers = ref<GroupsManagerUser[]>([])
const creating = ref(false)

const openCreate = () => {
  newName.value = ''
  newMembers.value = []
  createOpen.value = true
}

const toggleNewMember = (user: GroupsManagerUser, on: boolean) => {
  newMembers.value = on
    ? [...newMembers.value.filter(u => u.id !== user.id), user]
    : newMembers.value.filter(u => u.id !== user.id)
}

const onCreate = async () => {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const group = await $fetch<{ id: string }>(props.apiBase, { method: 'POST', body: { name: newName.value } })
    const added = await Promise.allSettled(newMembers.value.map(u =>
      $fetch(`${props.apiBase}/${group.id}/members/${u.id}`, { method: 'PUT' })))
    const failed = added.filter(r => r.status === 'rejected').length
    if (failed > 0) {
      toast.add({ title: 'Group created', description: `${failed} ${failed === 1 ? 'member' : 'members'} couldn't be added.`, color: 'warning' })
    }
    createOpen.value = false
    await refresh()
  } catch (err: unknown) {
    toast.add({ title: 'Create failed', description: errorMessage(err), color: 'error' })
  } finally {
    creating.value = false
  }
}

const renamingId = ref<string | null>(null)
const renameValue = ref('')

const startRename = (group: ScopeGroup) => {
  renamingId.value = group.id
  renameValue.value = group.name
}

const onRename = async (group: ScopeGroup) => {
  try {
    await $fetch(`${props.apiBase}/${group.id}`, { method: 'PATCH', body: { name: renameValue.value } })
    renamingId.value = null
    await refresh()
  } catch (err: unknown) {
    toast.add({ title: 'Rename failed', description: errorMessage(err), color: 'error' })
  }
}

const onSetArchived = async (group: ScopeGroup, archived: boolean) => {
  try {
    await $fetch(`${props.apiBase}/${group.id}`, { method: 'PATCH', body: { archived } })
    await refresh()
  } catch (err: unknown) {
    toast.add({ title: 'Update failed', description: errorMessage(err), color: 'error' })
  }
}

const onDelete = async (group: ScopeGroup) => {
  if (!await confirmAction({
    title: `Delete ${group.name}?`,
    description: 'Members lose any app access that came from this group.',
    confirmLabel: 'Delete'
  })) return
  try {
    await $fetch(`${props.apiBase}/${group.id}`, { method: 'DELETE' })
    await refresh()
  } catch (err: unknown) {
    toast.add({ title: 'Delete failed', description: errorMessage(err), color: 'error' })
  }
}

const membersGroup = ref<ScopeGroup | null>(null)
const membersOpen = computed({
  get: () => membersGroup.value !== null,
  set: (v: boolean) => { if (!v) membersGroup.value = null }
})
const members = ref<GroupMember[]>([])
const membersLoading = ref(false)
const busyUserId = ref<string | null>(null)
const memberUsers = computed<GroupsManagerUser[]>(() =>
  members.value.map(m => ({ id: m.user_id, display_name: m.display_name, email: m.email, avatar: m.avatar })))

const loadMembers = async () => {
  if (!membersGroup.value) return
  membersLoading.value = true
  try {
    const res = await $fetch<{ members: GroupMember[] }>(`${props.apiBase}/${membersGroup.value.id}/members`)
    members.value = res.members
  } finally {
    membersLoading.value = false
  }
}

const openMembers = async (group: ScopeGroup) => {
  membersGroup.value = group
  members.value = []
  await loadMembers()
}

const onToggleMember = async (user: GroupsManagerUser, on: boolean) => {
  if (!membersGroup.value) return
  busyUserId.value = user.id
  try {
    await $fetch(`${props.apiBase}/${membersGroup.value.id}/members/${user.id}`, { method: on ? 'PUT' : 'DELETE' })
    await Promise.all([loadMembers(), refresh()])
  } catch (err: unknown) {
    toast.add({ title: on ? 'Add failed' : 'Remove failed', description: errorMessage(err), color: 'error' })
  } finally {
    busyUserId.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-2">
      <slot
        name="header"
        :mode="mode"
      />
      <UButton
        icon="i-lucide-plus"
        class="ml-auto"
        @click="openCreate"
      >
        Add group
      </UButton>
    </div>

    <div
      v-if="modeEditable"
      class="flex items-center gap-2"
    >
      <span class="text-sm font-medium">Groups run as</span>
      <InfoTip>
        <p>Audiences only open apps for their members, who don't see each other.</p>
        <p>Teams also let content be limited to them, and members see their teams and who's in them.</p>
      </InfoTip>
      <USelect
        :model-value="mode"
        :items="MODE_ITEMS"
        :loading="savingMode"
        size="sm"
        class="w-36"
        @update:model-value="onSetMode($event as GroupMode)"
      />
    </div>

    <UModal
      v-model:open="createOpen"
      title="New group"
    >
      <template #body>
        <form
          id="groups-manager-create"
          class="space-y-4"
          @submit.prevent="onCreate"
        >
          <UFormField label="Name">
            <UInput
              v-model="newName"
              autofocus
              class="w-full"
            />
          </UFormField>
          <UFormField label="Members">
            <GroupMemberPicker
              :search-users="searchUsers"
              :selected="newMembers"
              @toggle="toggleNewMember"
            />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            variant="ghost"
            color="neutral"
            @click="createOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            form="groups-manager-create"
            :loading="creating"
            :disabled="!newName.trim()"
          >
            Create group
          </UButton>
        </div>
      </template>
    </UModal>

    <div
      v-if="pending && groups.length === 0"
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
        v-for="group in groups"
        :key="group.id"
        class="flex items-center justify-between gap-3 p-4"
      >
        <div class="min-w-0">
          <form
            v-if="renamingId === group.id"
            class="flex gap-2"
            @submit.prevent="onRename(group)"
          >
            <UInput
              v-model="renameValue"
              size="sm"
              autofocus
            />
            <UButton
              type="submit"
              size="sm"
            >
              Save
            </UButton>
            <UButton
              size="sm"
              variant="ghost"
              color="neutral"
              @click="renamingId = null"
            >
              Cancel
            </UButton>
          </form>
          <template v-else>
            <div class="font-medium flex items-center gap-2">
              {{ group.name }}
              <UBadge
                v-if="group.archived_at"
                color="neutral"
                variant="subtle"
                size="sm"
              >
                Archived
              </UBadge>
            </div>
            <div class="text-xs text-(--ui-text-muted)">
              {{ group.member_count }} {{ group.member_count === 1 ? 'member' : 'members' }}
            </div>
          </template>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-lucide-users"
            @click="openMembers(group)"
          >
            Members
          </UButton>
          <UDropdownMenu
            :items="[
              { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => startRename(group) },
              group.archived_at
                ? { label: 'Restore', icon: 'i-lucide-archive-restore', onSelect: () => onSetArchived(group, false) }
                : { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => onSetArchived(group, true) },
              { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => onDelete(group) }
            ]"
          >
            <UButton
              variant="ghost"
              color="neutral"
              size="sm"
              icon="i-lucide-ellipsis"
              aria-label="Group actions"
            />
          </UDropdownMenu>
        </div>
      </li>
    </ul>

    <USlideover
      v-model:open="membersOpen"
      :title="membersGroup ? `${membersGroup.name} — members` : ''"
    >
      <template #body>
        <div
          v-if="membersLoading && members.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          Loading...
        </div>
        <GroupMemberPicker
          v-else
          :search-users="searchUsers"
          :selected="memberUsers"
          :busy-id="busyUserId"
          @toggle="onToggleMember"
        />
      </template>
    </USlideover>
  </div>
</template>
