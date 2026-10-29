<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

type UserStatus = 'active' | 'not_verified'

interface AdminUserRow {
  id: string
  display_name: string
  // Null for accounts created without an address (e.g. a host's app installs).
  email: string | null
  verified: boolean
  is_admin: boolean
  status: UserStatus
  created: string
  last_login: string | null
  orgs: { id: string, slug: string, name: string, roles: string[] }[]
}

const STATUS_META: Record<UserStatus, { label: string, color: 'success' | 'warning' | 'info' | 'error', icon: string }> = {
  active: { label: 'Active', color: 'success', icon: 'i-lucide-badge-check' },
  not_verified: { label: 'Not verified', color: 'warning', icon: 'i-lucide-mail-warning' }
}

interface UsersResponse {
  rows: AdminUserRow[]
  total: number
  page: number
  pageSize: number
}

const UIcon = resolveComponent('UIcon')
const UButton = resolveComponent('UButton')
const UBadge = resolveComponent('UBadge')

const toast = useToast()
const confirmAction = useConfirm()
const { user: currentUser } = useAuth()

const page = ref(1)
const pageSize = ref(50)
const search = ref('')
const sortField = ref<'display_name' | 'email' | 'status' | 'created' | 'last_login'>('created')
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

const { data, pending, error, refresh } = await useFetch<UsersResponse>('/api/admin/users', {
  query: queryKey,
  watch: [queryKey],
  default: () => ({ rows: [], total: 0, page: 1, pageSize: 50 })
})

// Tenancy-only data. The org-membership UI (table column, slideover section,
// invite-modal attachments) only renders when this is true; the orgs list
// fetch is also skipped in single-tenant deploys where the endpoint doesn't
// exist.
const tenancyEnabled = computed(() => useRuntimeConfig().public.tenancy === true)

interface AdminOrg {
  id: string
  slug: string
  name: string
}
const { data: orgsData } = tenancyEnabled.value
  ? await useFetch<{ orgs: AdminOrg[] }>(
    '/api/admin/orgs',
    { default: () => ({ orgs: [] }) }
  )
  : { data: ref<{ orgs: AdminOrg[] }>({ orgs: [] }) }
const allOrgs = computed(() => orgsData.value?.orgs ?? [])

interface StaticRole {
  key: string
  name: string
  description: string
  source: string
}
const { data: staticRolesData } = tenancyEnabled.value
  ? await useFetch<{ roles: StaticRole[] }>(
    '/api/admin/static-roles',
    { default: () => ({ roles: [] }) }
  )
  : { data: ref<{ roles: StaticRole[] }>({ roles: [] }) }
const staticRoles = computed(() => staticRolesData.value?.roles ?? [])

// Personal apps (both modes). The invite form lists the invite-only ones;
// apps on for everyone need no grant.
interface AdminPersonalApp {
  id: string
  title: string
  icon?: string
  status: 'disabled' | 'available' | 'default' | 'host_controlled'
  scope: 'org' | 'user'
  installed: boolean
}
const { data: appsData } = await useFetch<{ apps: AdminPersonalApp[] }>('/api/admin/apps', {
  default: () => ({ apps: [] })
})
const invitablePersonalApps = computed(() => (appsData.value?.apps ?? [])
  .filter(a => a.scope === 'user' && a.installed && (a.status === 'host_controlled' || a.status === 'available')))

interface AttachmentDraft {
  orgId: string
  roles: string
}
const inviteOpen = ref(false)
// 'email' sends the invite to an address; 'link' creates a single-use link
// the admin shares themselves.
const inviteMode = ref<'email' | 'link'>('email')
const createdLink = ref('')
const inviteEmail = ref('')
const inviteDisplayName = ref('')
const inviteAttachments = ref<AttachmentDraft[]>([])
const inviteApps = ref<string[]>([])
const inviting = ref(false)
const inviteError = ref('')

const openInvite = () => {
  inviteMode.value = 'email'
  createdLink.value = ''
  inviteEmail.value = ''
  inviteDisplayName.value = ''
  inviteAttachments.value = []
  inviteApps.value = []
  inviteError.value = ''
  inviteOpen.value = true
}

const toggleInviteApp = (appId: string) => {
  inviteApps.value = inviteApps.value.includes(appId)
    ? inviteApps.value.filter(id => id !== appId)
    : [...inviteApps.value, appId]
}

const toggleAttachment = (orgId: string) => {
  const idx = inviteAttachments.value.findIndex(a => a.orgId === orgId)
  if (idx >= 0) {
    inviteAttachments.value = inviteAttachments.value.filter(a => a.orgId !== orgId)
  } else {
    inviteAttachments.value = [...inviteAttachments.value, { orgId, roles: 'member' }]
  }
}
const isAttached = (orgId: string) => inviteAttachments.value.some(a => a.orgId === orgId)
const setRolesFor = (orgId: string, val: string) => {
  inviteAttachments.value = inviteAttachments.value.map(a =>
    a.orgId === orgId ? { ...a, roles: val } : a
  )
}
const rolesFor = (orgId: string) =>
  inviteAttachments.value.find(a => a.orgId === orgId)?.roles ?? ''

const canSubmitInvite = computed(() => {
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.value.trim())
  if (inviteMode.value === 'email' && !emailOk) return false
  // Org attachments only required when tenancy is loaded, unless the invite
  // carries a personal app.
  if (!tenancyEnabled.value) return true
  const rolesOk = inviteAttachments.value.every(a => a.roles.split(',').map(s => s.trim()).filter(Boolean).length > 0)
  return rolesOk && (inviteAttachments.value.length > 0 || inviteApps.value.length > 0)
})

const submitInvite = async () => {
  inviteError.value = ''
  inviting.value = true
  try {
    const res = await $fetch<{ invite?: { url?: string } }>('/api/admin/users/invite', {
      method: 'POST',
      body: {
        ...(inviteMode.value === 'link'
          ? { link: true }
          : { email: inviteEmail.value.trim().toLowerCase() }),
        display_name: inviteDisplayName.value.trim() || undefined,
        attachments: inviteAttachments.value.map(a => ({
          orgId: a.orgId,
          roles: a.roles.split(',').map(s => s.trim()).filter(Boolean)
        })),
        apps: inviteApps.value
      }
    })
    await Promise.all([refresh(), refreshInvites()])
    if (inviteMode.value === 'link' && res.invite?.url) {
      createdLink.value = res.invite.url
      return
    }
    inviteOpen.value = false
    toast.add({ title: res.invite ? 'Invitation sent' : 'User added', color: 'success' })
  } catch (err: unknown) {
    inviteError.value = (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage
      || (err as { message?: string } | null)?.message
      || 'Failed to invite'
  } finally {
    inviting.value = false
  }
}

interface PendingInvite {
  id: string
  kind: 'email' | 'link'
  email: string | null
  display_name: string | null
  inviter_name: string | null
  created_at: string
  expires_at: string
  status: 'valid' | 'expired'
  orgs: { id: string, slug: string, name: string, roles: string[] }[]
  apps: { id: string, title: string }[]
}

const { data: invitesData, refresh: refreshInvites } = await useFetch<{ invites: PendingInvite[] }>('/api/admin/invites', {
  default: () => ({ invites: [] })
})
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
    const res = await $fetch<{ url?: string }>(`/api/admin/invites/${inv.id}/resend`, { method: 'POST' })
    await refreshInvites()
    if (res.url) {
      inviteMode.value = 'link'
      createdLink.value = res.url
      inviteOpen.value = true
    } else {
      toast.add({ title: 'Invitation re-sent', color: 'success' })
    }
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage || 'Failed to resend', color: 'error' })
  } finally {
    inviteBusy.value = null
  }
}

const revokeInvite = async (inv: PendingInvite) => {
  inviteBusy.value = inv.id
  try {
    await $fetch(`/api/admin/invites/${inv.id}`, { method: 'DELETE' })
    await refreshInvites()
    toast.add({ title: 'Invitation revoked', color: 'success' })
  } catch (err: unknown) {
    toast.add({ title: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage || 'Failed to revoke', color: 'error' })
  } finally {
    inviteBusy.value = null
  }
}

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

const sortableHeader = (label: string, field: typeof sortField.value) => () =>
  h(UButton, {
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

const columns: TableColumn<AdminUserRow>[] = [
  {
    accessorKey: 'display_name',
    header: sortableHeader('Name', 'display_name'),
    cell: ({ row }) => h('div', { class: 'flex items-center gap-2' }, [
      h('span', {}, row.original.display_name || '—'),
      row.original.is_admin
        ? h(UBadge, { color: 'warning', variant: 'subtle', size: 'sm' }, () => 'Host admin')
        : null
    ])
  },
  {
    accessorKey: 'email',
    header: sortableHeader('Email', 'email'),
    cell: ({ row }) => row.original.email ?? h(UBadge, { color: 'neutral', variant: 'subtle', size: 'sm' }, () => 'No email')
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
  ...(tenancyEnabled.value
    ? [{
        accessorKey: 'orgs',
        header: 'Organizations',
        cell: ({ row }: { row: { original: AdminUserRow } }) => {
          const orgs = row.original.orgs
          if (orgs.length === 0) {
            return h('span', { class: 'text-(--ui-text-muted) text-sm' }, '—')
          }
          return h('div', { class: 'flex flex-wrap gap-1' }, orgs.map(o =>
            h(UBadge, { color: 'neutral', variant: 'subtle', size: 'sm' }, () => o.name)
          ))
        }
      } as TableColumn<AdminUserRow>]
    : []),
  {
    accessorKey: 'created',
    header: sortableHeader('Created', 'created'),
    cell: ({ row }) => formatDate(row.original.created)
  },
  {
    accessorKey: 'last_login',
    header: sortableHeader('Last login', 'last_login'),
    cell: ({ row }) => formatDate(row.original.last_login)
  }
]

const total = computed(() => data.value?.total ?? 0)
const rows = computed(() => data.value?.rows ?? [])

// Edit slideover state
const selectedUser = ref<AdminUserRow | null>(null)
const editName = ref('')
const saving = ref(false)

const slideoverOpen = computed({
  get: () => selectedUser.value !== null,
  set: (val: boolean) => {
    if (!val) selectedUser.value = null
  }
})

const trimmedName = computed(() => editName.value.trim())
const nameValid = computed(() => trimmedName.value.length >= 2)
const nameChanged = computed(() =>
  selectedUser.value !== null && trimmedName.value !== selectedUser.value.display_name
)
const canSave = computed(() => nameValid.value && nameChanged.value && !saving.value)

const openRow = (row: AdminUserRow) => {
  selectedUser.value = row
  editName.value = row.display_name
}

const handleRowSelect = (_event: Event, row: { original: AdminUserRow }) => {
  openRow(row.original)
}

const tableMeta = computed(() => ({
  class: {
    tr: (row: { original: AdminUserRow }) =>
      selectedUser.value?.id === row.original.id ? 'bg-(--ui-bg-accented)' : ''
  }
}))

const handleSave = async () => {
  if (!selectedUser.value || !canSave.value) return
  saving.value = true
  try {
    const response = await $fetch<{ user: AdminUserRow }>(`/api/admin/users/${selectedUser.value.id}`, {
      method: 'PATCH',
      body: { display_name: trimmedName.value }
    })

    if (data.value) {
      data.value = {
        ...data.value,
        rows: data.value.rows.map(r => r.id === response.user.id ? response.user : r)
      }
    }

    toast.add({ title: 'User updated', color: 'success' })
    selectedUser.value = null
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to update user',
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

const markingVerified = ref(false)
const sendingVerification = ref(false)
const sendingPasswordReset = ref(false)

const handleMarkVerified = async () => {
  if (!selectedUser.value || selectedUser.value.verified) return
  markingVerified.value = true
  try {
    const userId = selectedUser.value.id
    await $fetch(`/api/admin/users/${userId}/verify`, { method: 'POST' })

    if (data.value) {
      data.value = {
        ...data.value,
        rows: data.value.rows.map(r =>
          r.id === userId ? { ...r, verified: true, status: 'active' as UserStatus } : r
        )
      }
    }
    if (selectedUser.value) {
      selectedUser.value = { ...selectedUser.value, verified: true, status: 'active' }
    }
    toast.add({ title: 'User marked as verified', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Verification failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to mark user as verified',
      color: 'error'
    })
  } finally {
    markingVerified.value = false
  }
}

const handleSendVerification = async () => {
  if (!selectedUser.value || selectedUser.value.verified) return
  sendingVerification.value = true
  try {
    const userId = selectedUser.value.id
    await $fetch(`/api/admin/users/${userId}/send-verification`, { method: 'POST' })
    toast.add({ title: 'Verification email sent', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Send failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to send verification email',
      color: 'error'
    })
  } finally {
    sendingVerification.value = false
  }
}

const handleSendPasswordReset = async () => {
  if (!selectedUser.value) return
  sendingPasswordReset.value = true
  try {
    const userId = selectedUser.value.id
    await $fetch(`/api/admin/users/${userId}/send-password-reset`, { method: 'POST' })
    toast.add({ title: 'Password reset email sent', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Send failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to send password reset email',
      color: 'error'
    })
  } finally {
    sendingPasswordReset.value = false
  }
}

const hostAdminModalOpen = ref(false)
const savingHostAdmin = ref(false)

const handleSetHostAdmin = async () => {
  if (!selectedUser.value) return
  savingHostAdmin.value = true
  try {
    const userId = selectedUser.value.id
    const next = !selectedUser.value.is_admin
    await $fetch(`/api/admin/users/${userId}/host-admin`, { method: 'PUT', body: { is_admin: next } })

    if (data.value) {
      data.value = {
        ...data.value,
        rows: data.value.rows.map(r => r.id === userId ? { ...r, is_admin: next } : r)
      }
    }
    if (selectedUser.value?.id === userId) {
      selectedUser.value = { ...selectedUser.value, is_admin: next }
    }
    hostAdminModalOpen.value = false
    toast.add({ title: next ? 'Host admin granted' : 'Host admin removed', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to update host admin access',
      color: 'error'
    })
  } finally {
    savingHostAdmin.value = false
  }
}

// ---------- org memberships (slideover) ----------
type Membership = AdminUserRow['orgs'][number]

const editingOrgId = ref<string | null>(null)
const orgRoleDraft = ref<string>('admin')
const savingMembership = ref(false)
const removingOrgId = ref<string | null>(null)

const beginEditMembership = (m: Membership) => {
  editingOrgId.value = m.id
  // Single-select editor — if the membership has multiple roles today, show
  // the first; saving will replace the array with the picked role.
  orgRoleDraft.value = m.roles[0] ?? 'admin'
}
const cancelEditMembership = () => {
  editingOrgId.value = null
  orgRoleDraft.value = 'admin'
}

const patchMembershipLocal = (userId: string, orgId: string, mutator: (orgs: Membership[]) => Membership[]) => {
  if (data.value) {
    data.value = {
      ...data.value,
      rows: data.value.rows.map(r =>
        r.id === userId ? { ...r, orgs: mutator(r.orgs) } : r
      )
    }
  }
  if (selectedUser.value?.id === userId) {
    selectedUser.value = { ...selectedUser.value, orgs: mutator(selectedUser.value.orgs) }
  }
  void orgId
}

const handleSaveMembershipRoles = async (m: Membership) => {
  if (!selectedUser.value) return
  const role = orgRoleDraft.value
  if (!role) {
    toast.add({ title: 'Role required', description: 'Pick a role.', color: 'error' })
    return
  }
  const roles = [role]
  savingMembership.value = true
  try {
    const userId = selectedUser.value.id
    const response = await $fetch<{ user_id: string, roles: string[] }>(
      `/api/admin/orgs/${m.id}/members/${userId}/roles`,
      { method: 'PATCH', body: { roles } }
    )
    patchMembershipLocal(userId, m.id, orgs =>
      orgs.map(o => o.id === m.id ? { ...o, roles: response.roles } : o)
    )
    toast.add({ title: 'Roles updated', color: 'success' })
    cancelEditMembership()
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to update roles',
      color: 'error'
    })
  } finally {
    savingMembership.value = false
  }
}

const handleRemoveMembership = async (m: Membership) => {
  if (!selectedUser.value) return
  if (!await confirmAction({
    title: 'Remove from org?',
    description: `Remove ${selectedUser.value.display_name || selectedUser.value.email || 'this user'} from ${m.name}?`,
    confirmLabel: 'Remove'
  })) return
  removingOrgId.value = m.id
  try {
    const userId = selectedUser.value.id
    await $fetch(`/api/admin/orgs/${m.id}/members/${userId}`, { method: 'DELETE' })
    patchMembershipLocal(userId, m.id, orgs => orgs.filter(o => o.id !== m.id))
    toast.add({ title: 'Removed from org', description: m.name, color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Remove failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to remove from org',
      color: 'error'
    })
  } finally {
    removingOrgId.value = null
  }
}

// Add to org (typeahead). Filters out orgs the user is already in.
const addOrgSelected = ref<AdminOrg | undefined>(undefined)
const addOrgRole = ref<string>('admin')
const addingMembership = ref(false)

const availableOrgsToAdd = computed(() => {
  if (!selectedUser.value) return []
  const currentIds = new Set(selectedUser.value.orgs.map(o => o.id))
  return allOrgs.value.filter(o => !currentIds.has(o.id))
})

const handleAddMembership = async () => {
  if (!selectedUser.value || !addOrgSelected.value) return
  const role = addOrgRole.value
  if (!role) {
    toast.add({ title: 'Role required', description: 'Pick a role.', color: 'error' })
    return
  }
  const roles = [role]
  addingMembership.value = true
  try {
    const userId = selectedUser.value.id
    const target = addOrgSelected.value
    await $fetch(`/api/admin/orgs/${target.id}/members`, {
      method: 'POST',
      body: { userId, roles }
    })
    patchMembershipLocal(userId, target.id, orgs => [
      ...orgs,
      { id: target.id, slug: target.slug, name: target.name, roles }
    ].sort((a, b) => a.name.localeCompare(b.name)))
    toast.add({ title: 'Attached to org', description: target.name, color: 'success' })
    addOrgSelected.value = undefined
    addOrgRole.value = 'admin'
  } catch (err: unknown) {
    toast.add({
      title: 'Attach failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to attach',
      color: 'error'
    })
  } finally {
    addingMembership.value = false
  }
}

watch(selectedUser, (next, prev) => {
  if (next?.id !== prev?.id) {
    cancelEditMembership()
    addOrgSelected.value = undefined
    addOrgRole.value = 'admin'
  }
})

// ---------- personal apps (slideover) ----------
interface UserPersonalApp {
  id: string
  title: string
  icon?: string
  status: AdminPersonalApp['status']
  enabled: boolean
  granted: boolean
}
const userApps = ref<UserPersonalApp[]>([])
const togglingAppId = ref<string | null>(null)

const loadUserApps = async (userId: string) => {
  userApps.value = []
  try {
    const res = await $fetch<{ apps: UserPersonalApp[] }>(`/api/admin/users/${userId}/apps`)
    if (selectedUser.value?.id === userId) userApps.value = res.apps.filter(a => a.status !== 'disabled')
  } catch {
    // The section stays empty; toggling reports its own errors.
  }
}

const handleToggleUserApp = async (app: UserPersonalApp, granted: boolean) => {
  if (!selectedUser.value) return
  const userId = selectedUser.value.id
  togglingAppId.value = app.id
  try {
    await $fetch(`/api/admin/users/${userId}/apps/${app.id}`, { method: 'PUT', body: { granted } })
    await loadUserApps(userId)
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to update app access',
      color: 'error'
    })
  } finally {
    togglingAppId.value = null
  }
}

watch(() => selectedUser.value?.id, (id) => {
  if (id) void loadUserApps(id)
})

const deleteModalOpen = ref(false)
const deleting = ref(false)

const isSelf = computed(() =>
  !!(selectedUser.value && currentUser.value && selectedUser.value.id === currentUser.value.id)
)

const handleDelete = async () => {
  if (!selectedUser.value || isSelf.value) return
  deleting.value = true
  try {
    const userId = selectedUser.value.id
    await $fetch(`/api/admin/users/${userId}`, { method: 'DELETE' })
    toast.add({ title: 'User deleted', color: 'success' })
    deleteModalOpen.value = false
    selectedUser.value = null
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: 'Delete failed',
      description: (err as { data?: { statusMessage?: string }, message?: string } | null)?.data?.statusMessage || (err as { message?: string } | null)?.message || 'Failed to delete user',
      color: 'error'
    })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">
          Users
        </h1>
        <p class="text-sm text-(--ui-text-muted)">
          Global user accounts. Org membership is managed under each org's settings.
        </p>
      </div>
      <UButton
        icon="i-lucide-user-plus"
        @click="openInvite"
      >
        Invite user
      </UButton>
    </header>

    <UInput
      v-model="search"
      icon="i-lucide-search"
      placeholder="Search by name or email"
      size="md"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="(error as any)?.statusMessage || 'Failed to load users'"
    />

    <UTable
      :columns="columns"
      :data="rows"
      :loading="pending"
      :ui="{ tr: 'cursor-pointer' }"
      :meta="tableMeta"
      @select="handleRowSelect"
    />

    <div class="flex items-center justify-between">
      <span class="text-sm text-(--ui-text-muted)">
        {{ total }} user{{ total === 1 ? '' : 's' }}
      </span>
      <UPagination
        v-model:page="page"
        :items-per-page="pageSize"
        :total="total"
      />
    </div>

    <section
      v-if="pendingInvites.length"
      class="space-y-2"
    >
      <h2 class="text-lg font-semibold">
        Pending invitations
      </h2>
      <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
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
              <span v-if="inv.orgs.length">{{ inv.orgs.map(o => o.name).join(', ') }} · </span>
              <span v-if="inv.apps?.length">{{ inv.apps.map(a => a.title).join(', ') }} · </span>
              <span v-if="inv.inviter_name">by {{ inv.inviter_name }} · </span>
              expires {{ formatDate(inv.expires_at) }}
            </div>
          </div>
          <div class="flex gap-2 shrink-0">
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
      :ui="{ content: 'max-w-md' }"
    >
      <template #content>
        <div
          v-if="selectedUser"
          class="p-6 space-y-6"
        >
          <header>
            <h2 class="text-xl font-semibold">
              {{ selectedUser.display_name }}
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              {{ selectedUser.email ?? 'No email address' }}
            </p>
          </header>

          <UFormField label="Display name">
            <UInput
              v-model="editName"
              :disabled="saving"
            />
          </UFormField>

          <div class="flex gap-2">
            <UButton
              :loading="saving"
              :disabled="!canSave"
              @click="handleSave"
            >
              Save
            </UButton>
            <UButton
              variant="ghost"
              @click="selectedUser = null"
            >
              Cancel
            </UButton>
          </div>

          <hr class="border-(--ui-border)">

          <section class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-medium">
                Verification
              </h3>
              <UBadge
                :color="STATUS_META[selectedUser.status].color"
                :icon="STATUS_META[selectedUser.status].icon"
                :label="STATUS_META[selectedUser.status].label"
                variant="subtle"
                size="lg"
              />
            </div>
            <div class="flex gap-2 flex-wrap">
              <UButton
                v-if="selectedUser.status === 'not_verified'"
                :loading="markingVerified"
                @click="handleMarkVerified"
              >
                Mark verified
              </UButton>
              <UButton
                v-if="selectedUser.status === 'not_verified' && selectedUser.email"
                variant="outline"
                :loading="sendingVerification"
                @click="handleSendVerification"
              >
                Resend verification email
              </UButton>
              <UButton
                v-if="selectedUser.email"
                variant="outline"
                color="neutral"
                :loading="sendingPasswordReset"
                @click="handleSendPasswordReset"
              >
                Send password reset email
              </UButton>
            </div>
          </section>

          <hr class="border-(--ui-border)">

          <section class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-medium">
                Host admin
              </h3>
              <UBadge
                v-if="selectedUser.is_admin"
                color="warning"
                variant="subtle"
                size="lg"
              >
                Host admin
              </UBadge>
            </div>
            <p class="text-sm text-(--ui-text-muted)">
              Host admins manage every user and host setting.
            </p>
            <UButton
              :color="selectedUser.is_admin ? 'error' : 'primary'"
              variant="outline"
              :disabled="(selectedUser.is_admin && isSelf) || (!selectedUser.is_admin && !selectedUser.verified)"
              @click="hostAdminModalOpen = true"
            >
              {{ selectedUser.is_admin ? 'Remove host admin' : 'Make host admin' }}
            </UButton>
            <p
              v-if="selectedUser.is_admin && isSelf"
              class="text-xs text-(--ui-text-muted)"
            >
              You cannot remove your own host admin access.
            </p>
            <p
              v-else-if="!selectedUser.is_admin && !selectedUser.verified"
              class="text-xs text-(--ui-text-muted)"
            >
              Verify the user before making them a host admin.
            </p>
          </section>

          <template v-if="tenancyEnabled">
            <hr class="border-(--ui-border)">

            <section class="space-y-3">
              <h3 class="font-medium">
                Organizations
              </h3>

            <ul
              v-if="selectedUser.orgs.length > 0"
              class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
            >
              <li
                v-for="m in selectedUser.orgs"
                :key="m.id"
                class="p-3 space-y-2"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="min-w-0">
                    <div class="font-medium truncate">
                      {{ m.name }}
                    </div>
                    <div class="text-xs text-(--ui-text-muted) truncate">
                      /@{{ m.slug }}
                    </div>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                    <UButton
                      variant="ghost"
                      color="neutral"
                      size="xs"
                      icon="i-lucide-pencil"
                      :disabled="editingOrgId === m.id"
                      aria-label="Edit roles"
                      @click="beginEditMembership(m)"
                    />
                    <UButton
                      variant="ghost"
                      color="error"
                      size="xs"
                      icon="i-lucide-user-minus"
                      :loading="removingOrgId === m.id"
                      aria-label="Remove from org"
                      @click="handleRemoveMembership(m)"
                    />
                  </div>
                </div>

                <div
                  v-if="editingOrgId !== m.id"
                  class="flex flex-wrap gap-1"
                >
                  <UBadge
                    v-for="r in m.roles"
                    :key="r"
                    :color="r === 'admin' ? 'warning' : 'neutral'"
                    variant="subtle"
                    size="sm"
                  >
                    {{ r }}
                  </UBadge>
                  <span
                    v-if="m.roles.length === 0"
                    class="text-xs text-(--ui-text-muted)"
                  >
                    No roles
                  </span>
                </div>

                <div
                  v-else
                  class="flex items-center gap-2"
                >
                  <USelectMenu
                    v-model="orgRoleDraft"
                    :items="staticRoles"
                    value-key="key"
                    label-key="name"
                    placeholder="Pick a role..."
                    class="flex-1"
                    :disabled="savingMembership"
                  />
                  <UButton
                    size="xs"
                    :loading="savingMembership"
                    @click="handleSaveMembershipRoles(m)"
                  >
                    Save
                  </UButton>
                  <UButton
                    size="xs"
                    variant="ghost"
                    :disabled="savingMembership"
                    @click="cancelEditMembership"
                  >
                    Cancel
                  </UButton>
                </div>
              </li>
            </ul>
            <p
              v-else
              class="text-sm text-(--ui-text-muted)"
            >
              Not a member of any organization yet.
            </p>

            <div class="space-y-2 pt-2">
              <p class="text-xs font-medium uppercase tracking-wide text-(--ui-text-muted)">
                Add to org
              </p>
              <div
                v-if="availableOrgsToAdd.length === 0"
                class="text-sm text-(--ui-text-muted)"
              >
                Already a member of every org.
              </div>
              <div
                v-else
                class="flex flex-col sm:flex-row gap-2"
              >
                <USelectMenu
                  v-model="addOrgSelected"
                  :items="availableOrgsToAdd"
                  :search-input="{ placeholder: 'Search orgs...' }"
                  by="id"
                  label-key="name"
                  placeholder="Select an org..."
                  class="flex-1"
                  :disabled="addingMembership"
                />
                <USelectMenu
                  v-model="addOrgRole"
                  :items="staticRoles"
                  value-key="key"
                  label-key="name"
                  placeholder="Pick a role..."
                  class="sm:w-56"
                  :disabled="addingMembership"
                />
                <UButton
                  icon="i-lucide-plus"
                  :loading="addingMembership"
                  :disabled="!addOrgSelected || addingMembership"
                  @click="handleAddMembership"
                >
                  Add
                </UButton>
              </div>
            </div>
            </section>
          </template>

          <template v-if="userApps.length">
            <hr class="border-(--ui-border)">

            <section class="space-y-3">
              <h3 class="font-medium">
                Personal apps
              </h3>
              <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
                <li
                  v-for="app in userApps"
                  :key="app.id"
                  class="p-3 flex items-center justify-between gap-3"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <AppIcon
                      :name="app.icon"
                      class="size-5 shrink-0 text-xs"
                    />
                    <div class="min-w-0">
                      <div class="font-medium truncate">
                        {{ app.title }}
                      </div>
                      <div
                        v-if="app.status === 'default'"
                        class="text-xs text-(--ui-text-muted)"
                      >
                        On for everyone
                      </div>
                    </div>
                  </div>
                  <USwitch
                    :model-value="app.enabled"
                    :disabled="app.status === 'default' || togglingAppId === app.id"
                    @update:model-value="(v: boolean) => handleToggleUserApp(app, v)"
                  />
                </li>
              </ul>
            </section>
          </template>

          <hr class="border-(--ui-border)">

          <section class="space-y-2">
            <h3 class="font-medium text-red-600">
              Danger zone
            </h3>
            <UButton
              color="error"
              variant="outline"
              :disabled="isSelf"
              @click="deleteModalOpen = true"
            >
              Delete user
            </UButton>
            <p
              v-if="isSelf"
              class="text-xs text-(--ui-text-muted)"
            >
              You cannot delete your own account here.
            </p>
          </section>
        </div>
      </template>
    </USlideover>

    <UModal v-model:open="inviteOpen">
      <template #content>
        <div
          v-if="createdLink"
          class="p-6 space-y-4"
        >
          <h2 class="text-lg font-semibold">
            Invite link
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            Share this link with the person you're inviting. It works once and
            expires in 7 days; anyone who opens it first can join.
          </p>
          <UInput
            :model-value="createdLink"
            readonly
            class="w-full"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="inviteOpen = false"
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
          class="p-6 space-y-4"
          @submit.prevent="submitInvite"
        >
          <h2 class="text-lg font-semibold">
            Invite a user
          </h2>

          <p class="text-sm text-(--ui-text-muted)">
            New users get one email; existing users are silently attached to the
            chosen organizations and apps. Host admin can grant any role.
          </p>

          <URadioGroup
            v-model="inviteMode"
            orientation="horizontal"
            :items="[{ label: 'Send by email', value: 'email' }, { label: 'Create a link', value: 'link' }]"
            :disabled="inviting"
          />

          <UFormField
            v-if="inviteMode === 'email'"
            label="Email"
          >
            <UInput
              v-model="inviteEmail"
              type="email"
              autofocus
              :disabled="inviting"
            />
          </UFormField>

          <UFormField
            label="Display name"
            :hint="inviteMode === 'link' ? 'Optional — prefills their name.' : 'Used only when this email isn\'t already a user.'"
          >
            <UInput
              v-model="inviteDisplayName"
              :disabled="inviting"
            />
          </UFormField>

          <div
            v-if="tenancyEnabled"
            class="space-y-2"
          >
            <h3 class="font-medium">
              Attach to organizations
            </h3>
            <div
              v-if="allOrgs.length === 0"
              class="text-sm text-(--ui-text-muted)"
            >
              No organizations yet. Create one before inviting users.
            </div>
            <ul
              v-else
              class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md max-h-60 overflow-y-auto"
            >
              <li
                v-for="org in allOrgs"
                :key="org.id"
                class="p-3 flex items-start gap-3"
              >
                <UCheckbox
                  :model-value="isAttached(org.id)"
                  :disabled="inviting"
                  @update:model-value="toggleAttachment(org.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="font-medium">
                    {{ org.name }}
                  </div>
                  <div class="text-xs text-(--ui-text-muted)">
                    /@{{ org.slug }}
                  </div>
                  <USelectMenu
                    v-if="isAttached(org.id)"
                    :model-value="rolesFor(org.id)"
                    :items="staticRoles"
                    value-key="key"
                    label-key="name"
                    placeholder="Pick a role..."
                    size="sm"
                    class="mt-2"
                    :disabled="inviting"
                    @update:model-value="(v: string | number) => setRolesFor(org.id, String(v))"
                  />
                </div>
              </li>
            </ul>
          </div>

          <div
            v-if="invitablePersonalApps.length"
            class="space-y-2"
          >
            <h3 class="font-medium">
              Personal apps
            </h3>
            <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md max-h-60 overflow-y-auto">
              <li
                v-for="app in invitablePersonalApps"
                :key="app.id"
                class="p-3 flex items-center gap-3"
              >
                <UCheckbox
                  :model-value="inviteApps.includes(app.id)"
                  :disabled="inviting"
                  @update:model-value="toggleInviteApp(app.id)"
                />
                <AppIcon
                  :name="app.icon"
                  class="size-5 shrink-0 text-xs"
                />
                <span class="font-medium">{{ app.title }}</span>
              </li>
            </ul>
          </div>

          <UAlert
            v-if="inviteError"
            color="error"
            :title="inviteError"
          />
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="inviting"
              @click="inviteOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :loading="inviting"
              :disabled="!canSubmitInvite"
            >
              {{ inviteMode === 'link' ? 'Create link' : 'Send invite' }}
            </UButton>
          </div>
        </form>
      </template>
    </UModal>

    <UModal v-model:open="hostAdminModalOpen">
      <template #content>
        <div
          v-if="selectedUser"
          class="p-6 space-y-4"
        >
          <h2 class="text-lg font-semibold">
            {{ selectedUser.is_admin ? 'Remove host admin?' : 'Make host admin?' }}
          </h2>
          <p class="text-sm">
            <template v-if="selectedUser.is_admin">
              {{ selectedUser.display_name || selectedUser.email || 'This user' }} will lose access to the
              admin area.
            </template>
            <template v-else>
              {{ selectedUser.display_name || selectedUser.email || 'This user' }} will get full control of
              this deployment, including every user and host setting.
            </template>
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="savingHostAdmin"
              @click="hostAdminModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              :color="selectedUser.is_admin ? 'error' : 'primary'"
              :loading="savingHostAdmin"
              @click="handleSetHostAdmin"
            >
              {{ selectedUser.is_admin ? 'Remove' : 'Make host admin' }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="deleteModalOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Delete user?
          </h2>
          <p class="text-sm">
            This is permanent. The user will lose access to every organization
            they belong to.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="deleteModalOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="handleDelete"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
