<script setup lang="ts">
// Create, edit (name, icon, image), archive and delete one scope's groups and
// manage their members. The scope's routes live under `apiBase`:
//   GET    {apiBase}                         → { mode, groups }
//   POST   {apiBase}                         { name, icon }
//   PATCH  {apiBase}/:id                     { name, icon } | { archived }
//   DELETE {apiBase}/:id
//   POST   {apiBase}/:id/image               multipart `file`
//   DELETE {apiBase}/:id/image
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
  icon: string | null
  image: string | null
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

const { data: imageInfo } = useLazyFetch<{ can_upload: boolean, max_mb: number, types: string[], types_text: string }>('/api/profile/avatar', {
  key: 'profile-avatar',
  default: () => ({ can_upload: false, max_mb: 0, types: [], types_text: '' })
})

// One modal creates a group (with its first members) or edits one.
const formOpen = ref(false)
const editing = ref<ScopeGroup | null>(null)
const formName = ref('')
const formIcon = ref<string | null>(null)
const newMembers = ref<GroupsManagerUser[]>([])
const saving = ref(false)

// The picked image file is uploaded on save; `imagePreview` is what the
// avatar shows meanwhile (the picked file, or the group's current image).
const imageFile = ref<File | null>(null)
const imagePreview = ref<string | null>(null)
const removeImage = ref(false)

// An image file dropped anywhere on the form becomes the group's image.
// dragenter and dragleave fire for every child crossed, hence a depth count.
const dragDepth = ref(0)

const resetImage = (current: string | null) => {
  if (imageFile.value && imagePreview.value) URL.revokeObjectURL(imagePreview.value)
  imageFile.value = null
  imagePreview.value = current
  removeImage.value = false
}

const openCreate = () => {
  editing.value = null
  formName.value = ''
  formIcon.value = null
  resetImage(null)
  newMembers.value = []
  formOpen.value = true
}

const openEdit = (group: ScopeGroup) => {
  editing.value = group
  formName.value = group.name
  formIcon.value = group.icon
  resetImage(group.image)
  formOpen.value = true
}

watch(formOpen, (open) => {
  if (open) return
  resetImage(null)
  dragDepth.value = 0
})

// Returns whether the file was accepted.
const setImage = (file: File): boolean => {
  if (!imageInfo.value.types.includes(file.type)) {
    toast.add({ title: `Use a ${imageInfo.value.types_text} image`, color: 'error' })
    return false
  }
  if (file.size > imageInfo.value.max_mb * 1024 * 1024) {
    toast.add({ title: `Image too large (max ${imageInfo.value.max_mb} MB)`, color: 'error' })
    return false
  }
  resetImage(URL.createObjectURL(file))
  imageFile.value = file
  return true
}

const onRemoveImage = () => {
  const hadImage = !!editing.value?.image
  resetImage(null)
  removeImage.value = hadImage
}

// The avatar opens a popover with the icon grid and, where a group can have
// an image, an Image tab.
const AVATAR_TABS = [
  { label: 'Icon', value: 'icon' },
  { label: 'Image', value: 'image' }
]
const avatarOpen = ref(false)
const avatarTab = ref<string>('icon')
const imageAllowed = computed(() => imageInfo.value.can_upload || !!imagePreview.value)

watch(avatarOpen, (open) => {
  if (open) avatarTab.value = imagePreview.value ? 'image' : 'icon'
})

// An image shows instead of the icon, so picking an icon drops the image.
const onPickIcon = (name: string | null) => {
  formIcon.value = name
  if (name && imagePreview.value) onRemoveImage()
  avatarOpen.value = false
}

// A file dropped on or browsed from the Image tab's drop zone.
const onChooseImage = (file: File | null | undefined) => {
  if (file && setImage(file)) avatarOpen.value = false
}

const isFileDrag = (event: DragEvent) =>
  imageInfo.value.can_upload && !!event.dataTransfer?.types.includes('Files')

const onDragEnter = (event: DragEvent) => {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth.value++
}

const onDragOver = (event: DragEvent) => {
  if (isFileDrag(event)) event.preventDefault()
}

const onDragLeave = (event: DragEvent) => {
  if (isFileDrag(event)) dragDepth.value = Math.max(0, dragDepth.value - 1)
}

const onDrop = (event: DragEvent) => {
  if (!isFileDrag(event)) return
  event.preventDefault()
  dragDepth.value = 0
  const file = event.dataTransfer?.files[0]
  if (file) setImage(file)
}

const saveImage = async (id: string) => {
  if (imageFile.value) {
    const body = new FormData()
    body.append('file', imageFile.value)
    await $fetch(`${props.apiBase}/${id}/image`, { method: 'POST', body })
  } else if (removeImage.value) {
    await $fetch(`${props.apiBase}/${id}/image`, { method: 'DELETE' })
  }
}

const toggleNewMember = (user: GroupsManagerUser, on: boolean) => {
  newMembers.value = on
    ? [...newMembers.value.filter(u => u.id !== user.id), user]
    : newMembers.value.filter(u => u.id !== user.id)
}

const onCreate = async () => {
  const group = await $fetch<{ id: string }>(props.apiBase, { method: 'POST', body: { name: formName.value, icon: formIcon.value } })
  const problems: string[] = []
  if (!await saveImage(group.id).then(() => true, () => false)) problems.push('The image couldn\'t be uploaded.')
  const added = await Promise.allSettled(newMembers.value.map(u =>
    $fetch(`${props.apiBase}/${group.id}/members/${u.id}`, { method: 'PUT' })))
  const failed = added.filter(r => r.status === 'rejected').length
  if (failed > 0) problems.push(`${failed} ${failed === 1 ? 'member' : 'members'} couldn't be added.`)
  if (problems.length > 0) {
    toast.add({ title: 'Group created', description: problems.join(' '), color: 'warning' })
  }
}

const onEdit = async (group: ScopeGroup) => {
  const body: { name?: string, icon?: string | null } = {}
  if (formName.value !== group.name) body.name = formName.value
  if (formIcon.value !== group.icon) body.icon = formIcon.value
  if (Object.keys(body).length > 0) await $fetch(`${props.apiBase}/${group.id}`, { method: 'PATCH', body })
  await saveImage(group.id)
}

const onSave = async () => {
  if (!formName.value.trim()) return
  saving.value = true
  try {
    if (editing.value) await onEdit(editing.value)
    else await onCreate()
    formOpen.value = false
  } catch (err: unknown) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
    await refresh()
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
      v-model:open="formOpen"
      :title="editing ? 'Edit group' : 'New group'"
    >
      <template #body>
        <form
          id="groups-manager-form"
          class="space-y-4"
          @submit.prevent="onSave"
          @dragenter="onDragEnter"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <UFormField label="Name">
            <div
              class="flex items-center gap-3 rounded-md outline-2 outline-dashed outline-offset-4"
              :class="dragDepth > 0 ? 'outline-(--ui-primary)' : 'outline-transparent'"
            >
              <UPopover
                v-model:open="avatarOpen"
                :ui="{ content: 'w-72' }"
              >
                <button
                  type="button"
                  class="relative shrink-0 rounded-full cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
                  :aria-label="imageAllowed ? 'Choose an icon or image' : 'Choose an icon'"
                  :title="imageAllowed ? 'Choose an icon or image' : 'Choose an icon'"
                >
                  <GroupAvatar
                    :name="formName"
                    :icon="formIcon"
                    :image="imagePreview"
                    size="lg"
                  />
                  <span class="absolute -bottom-1 -right-1 flex items-center justify-center size-4 rounded-full bg-(--ui-bg) ring ring-(--ui-border-accented) text-(--ui-text-muted)">
                    <UIcon
                      name="i-lucide-pencil"
                      class="size-2.5"
                    />
                  </span>
                </button>
                <template #content>
                  <div
                    v-if="imageAllowed"
                    class="px-3 pt-3"
                  >
                    <UTabs
                      v-model="avatarTab"
                      :items="AVATAR_TABS"
                      :content="false"
                      size="xs"
                    />
                  </div>
                  <IconPickerPanel
                    v-if="avatarTab === 'icon' || !imageAllowed"
                    :selected="formIcon"
                    @select="onPickIcon"
                  />
                  <div
                    v-else
                    class="p-3 space-y-2"
                  >
                    <UFileUpload
                      v-if="imageInfo.can_upload"
                      :model-value="null"
                      :accept="imageInfo.types.join(',')"
                      reset
                      variant="area"
                      icon="i-lucide-image-up"
                      :label="imagePreview ? 'Drop a new image here or click to upload' : 'Drop an image here or click to upload'"
                      :description="`${imageInfo.types_text}, up to ${imageInfo.max_mb} MB`"
                      :preview="false"
                      class="w-full"
                      :ui="{ base: 'data-[dragging=true]:border-(--ui-primary)' }"
                      @update:model-value="onChooseImage"
                    />
                    <UButton
                      v-if="imagePreview"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-trash-2"
                      @click="onRemoveImage(); avatarOpen = false"
                    >
                      Remove
                    </UButton>
                  </div>
                </template>
              </UPopover>
              <UInput
                v-model="formName"
                autofocus
                class="flex-1"
              />
            </div>
          </UFormField>
          <UFormField
            v-if="!editing"
            label="Members"
          >
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
            @click="formOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            form="groups-manager-form"
            :loading="saving"
            :disabled="!formName.trim()"
          >
            {{ editing ? 'Save' : 'Create group' }}
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
        <div class="min-w-0 flex items-center gap-3">
          <GroupAvatar
            :name="group.name"
            :icon="group.icon"
            :image="group.image"
            size="md"
          />
          <div class="min-w-0">
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
          </div>
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
              { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => openEdit(group) },
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
