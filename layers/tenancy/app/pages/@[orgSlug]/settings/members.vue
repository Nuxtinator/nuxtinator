<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { AssignableRole } from '../../../composables/useOrgAssignableRoles'

definePageMeta({
  middleware: 'auth'
})

type MemberStatus = 'active' | 'not_verified'

interface MemberRow {
  membership_id: string
  user_id: string
  email: string
  display_name: string
  avatar: string | null
  editable: boolean
  roles: string[]
  status: MemberStatus
  joined_at: string
}

interface MembersResponse {
  rows: MemberRow[]
  total: number
  page: number
  pageSize: number
}

interface OrgInfo {
  id: string
  slug: string
  name: string
  perms: string[]
}

const STATUS_META: Record<MemberStatus, { label: string, color: 'success' | 'warning' | 'info' | 'error', icon: string }> = {
  active: { label: 'Active', color: 'success', icon: 'i-lucide-badge-check' },
  not_verified: { label: 'Not verified', color: 'warning', icon: 'i-lucide-mail-warning' }
}

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()
const { user: currentUser, checkAuth } = useAuth()
const { isHostAdmin } = usePermissions()

const { data: org } = await useFetch<OrgInfo>(() => `/api/o/${orgSlug.value}`, {
  watch: [orgSlug],
  key: () => `org-detail-members-${orgSlug.value}`
})

const myPerms = computed(() => new Set(org.value?.perms ?? []))
const has = (p: string) => myPerms.value.has(p)
const canInvite = computed(() => has('org.members.invite'))
const canRemove = computed(() => has('org.members.remove'))
const canManageRoles = computed(() => has('org.members.manage_roles'))
const canEditMembers = computed(() => has('org.members.edit_user') || isHostAdmin.value)
const canOpenMember = computed(() => canRemove.value || canManageRoles.value || canInvite.value || canEditMembers.value)

const { roles: assignableRoles, refresh: refreshRoles } = await useOrgAssignableRoles(orgSlug)

const roleLabel = (key: string) =>
  assignableRoles.value.find(r => r.key === key)?.name ?? key

const canAssignRole = (role: AssignableRole) =>
  role.permissions.every(p => myPerms.value.has(p))

const missingPermsForRole = (role: AssignableRole) =>
  role.permissions.filter(p => !myPerms.value.has(p))

const UIcon = resolveComponent('UIcon')
const UButton = resolveComponent('UButton')
const UBadge = resolveComponent('UBadge')

const page = ref(1)
const pageSize = ref(50)
const search = ref('')
const sortField = ref<'display_name' | 'email' | 'status' | 'joined_at'>('joined_at')
const sortDir = ref<'asc' | 'desc'>('desc')

const searchDebounced = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchDebounced.value = val
    page.value = 1
  }, 250)
})

const queryKey = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  q: searchDebounced.value,
  sort: sortField.value,
  dir: sortDir.value
}))

const { data, pending, error, refresh } = await useFetch<MembersResponse>(
  () => `/api/o/${orgSlug.value}/members`,
  {
    query: queryKey,
    watch: [queryKey, orgSlug],
    default: () => ({ rows: [], total: 0, page: 1, pageSize: 50 })
  }
)

const toggleSort = (field: typeof sortField.value) => {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortField.value = field
    sortDir.value = 'asc'
  }
  page.value = 1
}

const sortIcon = (field: typeof sortField.value) => {
  if (sortField.value !== field) return 'i-lucide-chevrons-up-down'
  return sortDir.value === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'
}

const formatDate = (value: string | Date | null | undefined) => {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

const relativeTime = (input: string | number | Date | null | undefined) => {
  if (!input) return null
  const d = input instanceof Date
    ? input
    : new Date(typeof input === 'string' ? input : Number(input))
  if (Number.isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  const abs = Math.abs(diffMs)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const sign = diffMs >= 0 ? -1 : 1
  if (abs < minute) return rtf.format(sign * Math.round(abs / 1000), 'second')
  if (abs < hour) return rtf.format(sign * Math.round(abs / minute), 'minute')
  if (abs < day) return rtf.format(sign * Math.round(abs / hour), 'hour')
  if (abs < week) return rtf.format(sign * Math.round(abs / day), 'day')
  if (abs < month) return rtf.format(sign * Math.round(abs / week), 'week')
  if (abs < year) return rtf.format(sign * Math.round(abs / month), 'month')
  return rtf.format(sign * Math.round(abs / year), 'year')
}

const initialsOf = (name: string | undefined | null, email: string | undefined | null) => {
  const source = (name || email || '').trim()
  if (!source) return '?'
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
  }
  return source.slice(0, 2).toUpperCase()
}

const sortableHeader = (label: string, field: typeof sortField.value) => {
  return () => h(UButton, {
    variant: 'ghost',
    color: 'neutral',
    size: 'xs',
    class: '-mx-2',
    trailingIcon: sortIcon(field),
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      toggleSort(field)
    }
  }, () => label)
}

const columns: TableColumn<MemberRow>[] = [
  {
    accessorKey: 'display_name',
    header: sortableHeader('Name', 'display_name'),
    cell: ({ row }) => row.original.display_name || '—'
  },
  {
    accessorKey: 'email',
    header: sortableHeader('Email', 'email')
  },
  {
    accessorKey: 'status',
    header: sortableHeader('Status', 'status'),
    cell: ({ row }) => {
      const meta = STATUS_META[row.original.status] ?? STATUS_META.active
      return h(UBadge, { color: meta.color, variant: 'subtle', size: 'sm' }, () => [
        h(UIcon, { name: meta.icon, class: 'size-3 mr-1' }),
        meta.label
      ])
    }
  },
  {
    accessorKey: 'roles',
    header: 'Roles',
    cell: ({ row }) => {
      const roles = row.original.roles ?? []
      if (roles.length === 0) {
        return h('span', { class: 'text-(--ui-text-muted) text-sm' }, '—')
      }
      return h('div', { class: 'flex flex-wrap gap-1' },
        roles.map(r => h(UBadge, {
          key: r,
          color: r === 'admin' ? 'warning' : 'neutral',
          variant: 'subtle',
          size: 'sm'
        }, () => roleLabel(r)))
      )
    }
  },
  {
    accessorKey: 'joined_at',
    header: sortableHeader('Joined', 'joined_at'),
    cell: ({ row }) => formatDate(row.original.joined_at)
  }
]

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])

// ---------- slideover ----------
const selectedMember = ref<MemberRow | null>(null)
const editRoles = ref<string[]>([])
const savingRoles = ref(false)

const slideoverOpen = computed({
  get: () => selectedMember.value !== null,
  set: (val: boolean) => { if (!val) selectedMember.value = null }
})

const isSelf = computed(() =>
  !!(selectedMember.value && currentUser.value && selectedMember.value.user_id === currentUser.value.id)
)

const openRow = (row: MemberRow) => {
  selectedMember.value = row
  editRoles.value = [...(row.roles ?? [])]
}

const handleRowSelect = (_event: Event, row: { original: MemberRow }) => {
  if (!canOpenMember.value) return
  openRow(row.original)
}

const tableMeta = computed(() => ({
  class: {
    tr: (row: { original: MemberRow }) =>
      selectedMember.value?.user_id === row.original.user_id ? 'bg-(--ui-bg-accented)' : ''
  }
}))

const toggleRole = (key: string) => {
  const idx = editRoles.value.indexOf(key)
  if (idx === -1) editRoles.value = [...editRoles.value, key]
  else editRoles.value = editRoles.value.filter(r => r !== key)
}

const rolesChanged = computed(() => {
  if (!selectedMember.value) return false
  const a = [...(selectedMember.value.roles ?? [])].sort()
  const b = [...editRoles.value].sort()
  return a.length !== b.length || a.some((r, i) => r !== b[i])
})

const handleSaveRoles = async () => {
  if (!selectedMember.value || !rolesChanged.value) return
  savingRoles.value = true
  try {
    const response = await $fetch<{ user_id: string, roles: string[] }>(
      `/api/o/${orgSlug.value}/members/${selectedMember.value.user_id}/roles`,
      { method: 'PATCH', body: { roles: editRoles.value } }
    )
    if (data.value) {
      data.value = {
        ...data.value,
        rows: data.value.rows.map(r =>
          r.user_id === response.user_id ? { ...r, roles: response.roles } : r
        )
      }
    }
    if (selectedMember.value) {
      selectedMember.value = { ...selectedMember.value, roles: response.roles }
    }
    toast.add({ title: 'Roles updated', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string }, message?: string })?.data?.statusMessage || (err as { message?: string })?.message || 'Failed to update roles',
      color: 'error'
    })
  } finally {
    savingRoles.value = false
  }
}

// ---------- avatar ----------
const { data: avatarInfo } = useLazyFetch<{ can_upload: boolean, max_mb: number, types: string[], types_text: string }>('/api/profile/avatar', {
  key: 'profile-avatar',
  default: () => ({ can_upload: false, max_mb: 0, types: [], types_text: '' })
})
const avatarInput = ref<HTMLInputElement | null>(null)
const avatarBusy = ref<'upload' | 'remove' | null>(null)

const applyAvatar = async (userId: string, avatar: string | null) => {
  if (data.value) {
    data.value = {
      ...data.value,
      rows: data.value.rows.map(r => r.user_id === userId ? { ...r, avatar } : r)
    }
  }
  if (selectedMember.value?.user_id === userId) {
    selectedMember.value = { ...selectedMember.value, avatar }
  }
  if (currentUser.value?.id === userId) await checkAuth()
}

const handleAvatarUpload = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (avatarInput.value) avatarInput.value.value = ''
  if (!file || !selectedMember.value) return
  if (!avatarInfo.value.types.includes(file.type)) {
    toast.add({ title: `Use a ${avatarInfo.value.types_text} image`, color: 'error' })
    return
  }
  if (file.size > avatarInfo.value.max_mb * 1024 * 1024) {
    toast.add({ title: `Image too large (max ${avatarInfo.value.max_mb} MB)`, color: 'error' })
    return
  }
  const userId = selectedMember.value.user_id
  avatarBusy.value = 'upload'
  try {
    const body = new FormData()
    body.append('file', file)
    const res = await $fetch<{ avatar: string }>(`/api/o/${orgSlug.value}/members/${userId}/avatar`, { method: 'POST', body })
    await applyAvatar(userId, res.avatar)
    toast.add({ title: 'Avatar updated', color: 'success' })
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } })?.data?.statusMessage || 'Could not upload the image', color: 'error' })
  } finally {
    avatarBusy.value = null
  }
}

const handleAvatarRemove = async () => {
  if (!selectedMember.value) return
  const userId = selectedMember.value.user_id
  avatarBusy.value = 'remove'
  try {
    await $fetch(`/api/o/${orgSlug.value}/members/${userId}/avatar`, { method: 'DELETE' })
    await applyAvatar(userId, null)
    toast.add({ title: 'Avatar removed', color: 'success' })
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } })?.data?.statusMessage || 'Could not remove the avatar', color: 'error' })
  } finally {
    avatarBusy.value = null
  }
}

// ---------- pending invites ----------
interface PendingInvite {
  id: string
  kind: 'email' | 'link'
  email: string | null
  display_name: string | null
  inviter_name: string | null
  roles: string[]
  created_at: string
  expires_at: string
  status: 'valid' | 'expired'
}

const { data: invitesData, refresh: refreshInvites } = await useFetch<{ invites: PendingInvite[] }>(
  () => `/api/o/${orgSlug.value}/invites`,
  {
    watch: [orgSlug],
    default: () => ({ invites: [] })
  }
)
const pendingInvites = computed(() => invitesData.value?.invites ?? [])
const inviteBusy = ref<string | null>(null)

const copyLink = async (url: string) => {
  try {
    await navigator.clipboard.writeText(url)
    toast.add({ title: 'Link copied', color: 'success' })
  } catch {
    toast.add({ title: 'Copy failed — select the link and copy it', color: 'warning' })
  }
}

// Email invites are re-sent; link invites get a new link (shown in the invite
// modal), since only the token's hash is stored.
const resendInvite = async (inv: PendingInvite) => {
  inviteBusy.value = inv.id
  try {
    const res = await $fetch<{ url?: string }>(`/api/o/${orgSlug.value}/invites/${inv.id}/resend`, { method: 'POST' })
    await refreshInvites()
    if (res.url) {
      inviteMode.value = 'link'
      createdLink.value = res.url
      inviteModalOpen.value = true
    } else {
      toast.add({ title: 'Invite re-sent', color: 'success' })
    }
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } })?.data?.statusMessage || 'Failed to resend invite', color: 'error' })
  } finally {
    inviteBusy.value = null
  }
}

const revokeInvite = async (inv: PendingInvite) => {
  inviteBusy.value = inv.id
  try {
    await $fetch(`/api/o/${orgSlug.value}/invites/${inv.id}`, { method: 'DELETE' })
    await refreshInvites()
    toast.add({ title: 'Invite revoked', color: 'success' })
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } })?.data?.statusMessage || 'Failed to revoke invite', color: 'error' })
  } finally {
    inviteBusy.value = null
  }
}

// ---------- invite modal ----------
const inviteModalOpen = ref(false)
// 'email' sends the invite to an address; 'link' creates a single-use link
// the inviter shares themselves.
const inviteMode = ref<'email' | 'link'>('email')
const createdLink = ref('')
const inviting = ref(false)
const inviteForm = reactive({
  email: '',
  display_name: '',
  roles: ['member'] as string[]
})
const inviteError = ref('')

const openInviteModal = () => {
  inviteMode.value = 'email'
  createdLink.value = ''
  inviteForm.email = ''
  inviteForm.display_name = ''
  inviteForm.roles = ['member']
  inviteError.value = ''
  refreshRoles()
  inviteModalOpen.value = true
}

const toggleInviteRole = (key: string) => {
  const idx = inviteForm.roles.indexOf(key)
  if (idx === -1) inviteForm.roles = [...inviteForm.roles, key]
  else inviteForm.roles = inviteForm.roles.filter(r => r !== key)
}

const inviteValid = computed(() =>
  inviteMode.value === 'link' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteForm.email.trim())
)

const handleInvite = async () => {
  if (!inviteValid.value || inviting.value) return
  inviteError.value = ''
  inviting.value = true
  try {
    const res = await $fetch<{ status: string, invite?: { url?: string } }>(`/api/o/${orgSlug.value}/invite`, {
      method: 'POST',
      body: {
        ...(inviteMode.value === 'link'
          ? { link: true }
          : { email: inviteForm.email.trim().toLowerCase() }),
        display_name: inviteForm.display_name.trim() || undefined,
        roles: inviteForm.roles
      }
    })
    await Promise.all([refresh(), refreshInvites()])
    if (inviteMode.value === 'link' && res.invite?.url) {
      createdLink.value = res.invite.url
      return
    }
    toast.add({
      title: res.status === 'attached' ? 'Member added' : 'Invite sent',
      description: inviteForm.email.trim().toLowerCase(),
      color: 'success'
    })
    inviteModalOpen.value = false
  } catch (err: unknown) {
    inviteError.value = (err as { data?: { statusMessage?: string }, message?: string })?.data?.statusMessage || (err as { message?: string })?.message || 'Failed to send invite'
  } finally {
    inviting.value = false
  }
}

// ---------- remove member ----------
const removeModalOpen = ref(false)
const removing = ref(false)

const requestRemove = () => {
  if (!selectedMember.value || isSelf.value) return
  removeModalOpen.value = true
}

const handleRemove = async () => {
  if (!selectedMember.value || isSelf.value) return
  removing.value = true
  try {
    const userId = selectedMember.value.user_id
    await $fetch(`/api/o/${orgSlug.value}/members/${userId}`, { method: 'DELETE' })
    if (data.value) {
      data.value = {
        ...data.value,
        rows: data.value.rows.filter(r => r.user_id !== userId),
        total: Math.max(0, data.value.total - 1)
      }
    }
    toast.add({ title: 'Member removed', color: 'success' })
    removeModalOpen.value = false
    selectedMember.value = null
  } catch (err: unknown) {
    toast.add({
      title: 'Remove failed',
      description: (err as { data?: { statusMessage?: string }, message?: string })?.data?.statusMessage || (err as { message?: string })?.message || 'Failed to remove member',
      color: 'error'
    })
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
      <h1 class="text-3xl font-bold">
        Members
      </h1>
      <div class="flex items-center gap-3 w-full sm:w-auto">
        <UInput
          v-model="search"
          placeholder="Search name or email..."
          icon="i-lucide-search"
          class="flex-1 sm:w-80"
        />
        <UButton
          v-if="canInvite"
          icon="i-lucide-user-plus"
          color="primary"
          @click="openInviteModal"
        >
          Invite member
        </UButton>
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      :title="error.statusMessage || 'Failed to load members'"
      class="mb-4"
    />

    <div class="border border-(--ui-border) rounded-lg overflow-hidden bg-(--ui-bg-elevated)">
      <UTable
        :data="rows"
        :columns="columns"
        :loading="pending"
        :empty-state="{ icon: 'i-lucide-users', label: 'No members found' }"
        :on-select="handleRowSelect"
        :meta="tableMeta"
        :ui="{ tr: canOpenMember ? 'transition-colors cursor-pointer' : 'transition-colors' }"
      />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-4 mt-4">
      <p class="text-sm text-(--ui-text-muted)">
        {{ total }} {{ total === 1 ? 'member' : 'members' }}
      </p>
      <UPagination
        v-model:page="page"
        :total="total"
        :items-per-page="pageSize"
      />
    </div>

    <section
      v-if="pendingInvites.length"
      class="mt-8"
    >
      <h2 class="text-lg font-semibold mb-3">
        Pending invites
      </h2>
      <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-lg bg-(--ui-bg-elevated)">
        <li
          v-for="inv in pendingInvites"
          :key="inv.id"
          class="p-3 flex items-center justify-between gap-3"
        >
          <div class="min-w-0">
            <div class="font-medium truncate">
              {{ inv.email || 'Invite link' }}
              <UBadge
                v-if="inv.status === 'expired'"
                color="error"
                variant="subtle"
                size="sm"
                class="ml-1"
              >
                Expired
              </UBadge>
            </div>
            <div class="text-xs text-(--ui-text-muted) truncate">
              {{ inv.roles.map(roleLabel).join(', ') }}
              <span v-if="inv.inviter_name"> · by {{ inv.inviter_name }}</span>
              · expires {{ formatDate(inv.expires_at) }}
            </div>
          </div>
          <div
            v-if="canInvite"
            class="flex gap-2 shrink-0"
          >
            <UButton
              size="sm"
              variant="outline"
              color="neutral"
              :loading="inviteBusy === inv.id"
              @click="resendInvite(inv)"
            >
              {{ inv.kind === 'email' ? 'Resend' : 'New link' }}
            </UButton>
            <UButton
              size="sm"
              variant="ghost"
              color="error"
              :disabled="inviteBusy === inv.id"
              @click="revokeInvite(inv)"
            >
              Revoke
            </UButton>
          </div>
        </li>
      </ul>
    </section>

    <USlideover
      v-model:open="slideoverOpen"
      side="right"
      :title="selectedMember?.display_name || ''"
      :ui="{ content: 'w-screen max-w-full sm:max-w-none sm:w-[50vw]' }"
    >
      <template #actions>
        <UTooltip
          v-if="canRemove"
          :text="isSelf ? 'You cannot remove yourself' : 'Remove from org'"
        >
          <UButton
            icon="i-lucide-user-minus"
            color="error"
            variant="ghost"
            size="sm"
            :disabled="isSelf"
            aria-label="Remove from org"
            @click="requestRemove"
          />
        </UTooltip>
      </template>
      <template #body>
        <div
          v-if="selectedMember"
          class="space-y-8"
        >
          <!-- Identity hero -->
          <section class="flex items-start gap-4">
            <img
              v-if="selectedMember.avatar"
              :src="selectedMember.avatar"
              :alt="selectedMember.display_name"
              class="shrink-0 size-16 rounded-full object-cover ring-1 ring-(--ui-border) shadow-sm"
            >
            <div
              v-else
              class="shrink-0 size-16 rounded-full bg-gradient-to-br from-(--ui-primary) to-(--ui-primary)/60 text-white flex items-center justify-center text-xl font-semibold ring-1 ring-(--ui-border) shadow-sm"
            >
              {{ initialsOf(selectedMember.display_name, selectedMember.email) }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-xl font-semibold truncate">
                  {{ selectedMember.display_name }}
                </h2>
                <UBadge
                  v-for="role in selectedMember.roles ?? []"
                  :key="role"
                  :color="role === 'admin' ? 'warning' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  <UIcon
                    v-if="role === 'admin'"
                    name="i-lucide-shield"
                    class="size-3 mr-1"
                  />
                  {{ roleLabel(role) }}
                </UBadge>
              </div>
              <a
                :href="`mailto:${selectedMember.email}`"
                class="text-sm text-(--ui-text-muted) hover:text-(--ui-text) transition-colors inline-flex items-center gap-1.5 mt-0.5 truncate"
              >
                <UIcon
                  name="i-lucide-mail"
                  class="size-3.5 shrink-0"
                />
                <span class="truncate">{{ selectedMember.email }}</span>
              </a>
              <div class="mt-2.5 flex items-center gap-2 flex-wrap">
                <UBadge
                  :color="STATUS_META[selectedMember.status].color"
                  variant="subtle"
                  size="sm"
                >
                  <UIcon
                    :name="STATUS_META[selectedMember.status].icon"
                    class="size-3 mr-1"
                  />
                  {{ STATUS_META[selectedMember.status].label }}
                </UBadge>
              </div>
              <div
                v-if="selectedMember.editable && (avatarInfo.can_upload || selectedMember.avatar)"
                class="mt-3 flex items-center gap-2 flex-wrap"
              >
                <template v-if="avatarInfo.can_upload">
                  <input
                    ref="avatarInput"
                    type="file"
                    :accept="avatarInfo.types.join(',')"
                    class="hidden"
                    @change="handleAvatarUpload"
                  >
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-upload"
                    :loading="avatarBusy === 'upload'"
                    :disabled="!!avatarBusy"
                    @click="avatarInput?.click()"
                  >
                    {{ selectedMember.avatar ? 'Change avatar' : 'Upload avatar' }}
                  </UButton>
                </template>
                <UButton
                  v-if="selectedMember.avatar"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-trash-2"
                  :loading="avatarBusy === 'remove'"
                  :disabled="!!avatarBusy"
                  @click="handleAvatarRemove"
                >
                  Remove avatar
                </UButton>
              </div>
            </div>
          </section>

          <!-- Stat card -->
          <section class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4">
              <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-(--ui-text-muted)">
                <UIcon
                  name="i-lucide-calendar-plus"
                  class="size-3.5"
                />
                <span>Joined</span>
              </div>
              <p class="mt-1.5 text-sm font-medium">
                {{ formatDate(selectedMember.joined_at) }}
              </p>
              <p class="text-xs text-(--ui-text-muted) mt-0.5">
                {{ relativeTime(selectedMember.joined_at) || '—' }}
              </p>
            </div>
          </section>

          <!-- Roles editor -->
          <section v-if="canManageRoles">
            <div class="flex items-center gap-2 mb-4">
              <UIcon
                name="i-lucide-shield"
                class="size-4 text-(--ui-text-muted)"
              />
              <h3 class="text-sm font-semibold uppercase tracking-wide text-(--ui-text-muted)">
                Roles
              </h3>
              <div class="flex-1 h-px bg-(--ui-border)" />
            </div>

            <div class="space-y-2">
              <label
                v-for="role in assignableRoles"
                :key="role.key"
                class="flex items-start gap-3 p-3 rounded-lg border border-(--ui-border) transition-colors"
                :class="canAssignRole(role)
                  ? 'hover:bg-(--ui-bg-accented) cursor-pointer'
                  : 'opacity-60 cursor-not-allowed'"
              >
                <UTooltip
                  :text="!canAssignRole(role)
                    ? `You lack: ${missingPermsForRole(role).join(', ')}`
                    : ''"
                  :disabled="canAssignRole(role)"
                >
                  <UCheckbox
                    :model-value="editRoles.includes(role.key)"
                    :disabled="savingRoles || !canAssignRole(role)"
                    @update:model-value="toggleRole(role.key)"
                  />
                </UTooltip>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-medium">{{ role.name }}</span>
                    <UBadge
                      v-if="role.source === 'custom'"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    >
                      Custom
                    </UBadge>
                    <UBadge
                      v-if="!canAssignRole(role)"
                      color="warning"
                      variant="subtle"
                      size="sm"
                    >
                      Cannot assign
                    </UBadge>
                  </div>
                  <div
                    v-if="role.description"
                    class="text-sm text-(--ui-text-muted) mt-0.5"
                  >
                    {{ role.description }}
                  </div>
                </div>
              </label>
            </div>

            <div class="flex items-center gap-3 pt-4">
              <UButton
                size="lg"
                icon="i-lucide-save"
                :loading="savingRoles"
                :disabled="!rolesChanged || savingRoles"
                @click="handleSaveRoles"
              >
                Save roles
              </UButton>
              <p
                v-if="rolesChanged"
                class="text-sm text-(--ui-text-muted)"
              >
                {{ editRoles.length }} {{ editRoles.length === 1 ? 'role' : 'roles' }} selected
              </p>
            </div>
          </section>
        </div>
      </template>
    </USlideover>

    <UModal
      v-model:open="inviteModalOpen"
      :dismissible="!inviting"
    >
      <template #content>
        <div
          v-if="createdLink"
          class="p-6 space-y-5"
        >
          <h3 class="text-lg font-semibold">
            Invite link
          </h3>
          <p class="text-sm text-(--ui-text-muted)">
            Share this link with the person you're inviting. It works once and
            expires in 7 days; anyone who opens it first can join.
          </p>
          <UInput
            :model-value="createdLink"
            readonly
            size="lg"
            class="w-full"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <div class="flex items-center justify-end gap-3">
            <UButton
              variant="ghost"
              color="neutral"
              @click="inviteModalOpen = false"
            >
              Done
            </UButton>
            <UButton
              icon="i-lucide-copy"
              @click="copyLink(createdLink)"
            >
              Copy link
            </UButton>
          </div>
        </div>
        <form
          v-else
          class="p-6 space-y-5"
          @submit.prevent="handleInvite"
        >
          <div class="flex items-start gap-3">
            <div class="shrink-0 size-10 rounded-full bg-(--ui-primary)/10 flex items-center justify-center">
              <UIcon
                name="i-lucide-user-plus"
                class="size-5 text-(--ui-primary)"
              />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold">
                Invite member
              </h3>
              <p class="text-sm text-(--ui-text-muted) mt-1">
                If this email is already a user, they're attached to this org silently. Otherwise they'll get an invite email with a 7-day link. Or create a single-use link to share yourself.
              </p>
            </div>
          </div>

          <UAlert
            v-if="inviteError"
            color="error"
            variant="soft"
            :title="inviteError"
            :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
            @close="inviteError = ''"
          />

          <URadioGroup
            v-model="inviteMode"
            orientation="horizontal"
            :items="[{ label: 'Send by email', value: 'email' }, { label: 'Create a link', value: 'link' }]"
            :disabled="inviting"
          />

          <UFormField
            v-if="inviteMode === 'email'"
            label="Email"
            required
          >
            <UInput
              v-model="inviteForm.email"
              type="email"
              placeholder="user@example.com"
              size="lg"
              :disabled="inviting"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="Display name"
            help="Optional. Prefills a new user's name; ignored if the email is already a user."
          >
            <UInput
              v-model="inviteForm.display_name"
              type="text"
              placeholder="Their name"
              size="lg"
              :disabled="inviting"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>

          <div>
            <label class="block text-sm font-medium mb-2">Roles</label>
            <div class="space-y-2">
              <label
                v-for="role in assignableRoles"
                :key="role.key"
                class="flex items-start gap-3 p-3 rounded-lg border border-(--ui-border) transition-colors"
                :class="canAssignRole(role)
                  ? 'hover:bg-(--ui-bg-accented) cursor-pointer'
                  : 'opacity-60 cursor-not-allowed'"
              >
                <UTooltip
                  :text="!canAssignRole(role)
                    ? `You lack: ${missingPermsForRole(role).join(', ')}`
                    : ''"
                  :disabled="canAssignRole(role)"
                >
                  <UCheckbox
                    :model-value="inviteForm.roles.includes(role.key)"
                    :disabled="inviting || !canAssignRole(role)"
                    @update:model-value="toggleInviteRole(role.key)"
                  />
                </UTooltip>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-medium">{{ role.name }}</span>
                    <UBadge
                      v-if="role.source === 'custom'"
                      color="neutral"
                      variant="subtle"
                      size="sm"
                    >
                      Custom
                    </UBadge>
                    <UBadge
                      v-if="!canAssignRole(role)"
                      color="warning"
                      variant="subtle"
                      size="sm"
                    >
                      Cannot assign
                    </UBadge>
                  </div>
                  <div
                    v-if="role.description"
                    class="text-sm text-(--ui-text-muted) mt-0.5"
                  >
                    {{ role.description }}
                  </div>
                </div>
              </label>
            </div>
          </div>

          <div class="flex items-center justify-end gap-3 pt-2">
            <UButton
              type="button"
              variant="ghost"
              color="neutral"
              :disabled="inviting"
              @click="inviteModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              icon="i-lucide-send"
              :loading="inviting"
              :disabled="!inviteValid || inviting"
            >
              {{ inviteMode === 'link' ? 'Create link' : 'Send invite' }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <UModal
      v-model:open="removeModalOpen"
      :dismissible="!removing"
    >
      <template #content>
        <div class="p-6 space-y-5">
          <div class="flex items-start gap-3">
            <div class="shrink-0 size-10 rounded-full bg-(--ui-error)/10 flex items-center justify-center">
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-5 text-(--ui-error)"
              />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold">
                Remove from org?
              </h3>
              <p class="text-sm text-(--ui-text-muted) mt-1">
                This will remove
                <span class="font-medium text-(--ui-text)">{{ selectedMember?.display_name }}</span>
                ({{ selectedMember?.email }}) from <span class="font-medium text-(--ui-text)">{{ org?.name }}</span>.
                Their global account is unaffected. They can be re-invited later.
              </p>
            </div>
          </div>
          <div class="flex items-center justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="removing"
              @click="removeModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              icon="i-lucide-user-minus"
              :loading="removing"
              @click="handleRemove"
            >
              Remove
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
