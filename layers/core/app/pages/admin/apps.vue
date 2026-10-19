<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

type AppStatus = 'disabled' | 'available' | 'default' | 'host_controlled'

interface AdminApp {
  id: string
  title: string
  description?: string
  icon?: string
  status: AppStatus
  scope: 'org' | 'user'
  installed: boolean
  created_at: string
  updated_at: string
}

const toast = useToast()

// Multi-tenant exposes three availability tiers per org; single-tenant has no
// orgs, so an app is simply on or off for this instance.
const tenancyEnabled = computed(() => useRuntimeConfig().public.tenancy === true)

const { data, pending, refresh } = await useFetch<{ apps: AdminApp[] }>(
  '/api/admin/apps',
  { default: () => ({ apps: [] }) }
)
const apps = computed(() => data.value?.apps ?? [])

const STATUS_OPTIONS: { value: AppStatus, label: string, description: string, color: 'success' | 'neutral' | 'warning' | 'error', icon: string }[] = [
  { value: 'default', label: 'Enabled for all', description: 'On for every org; an org admin can turn it off.', color: 'success', icon: 'i-lucide-circle-check' },
  { value: 'available', label: 'Available to all', description: 'Off until an org admin turns it on.', color: 'neutral', icon: 'i-lucide-circle-dashed' },
  { value: 'host_controlled', label: 'Host controlled', description: 'Off for every org until a host admin turns it on per org; org admins can\'t change it.', color: 'warning', icon: 'i-lucide-lock' },
  { value: 'disabled', label: 'Disabled', description: 'Hidden from every org.', color: 'error', icon: 'i-lucide-circle-x' }
]
const statusMeta = (s: AppStatus) => STATUS_OPTIONS.find(o => o.value === s) ?? STATUS_OPTIONS[1]!

// Personal apps are turned on per user, the same way in both modes.
// 'available' reads as invite-only, like 'host_controlled'.
const PERSONAL_STATUS_OPTIONS: typeof STATUS_OPTIONS = [
  { value: 'default', label: 'Everyone', description: 'On for every signed-in user.', color: 'success', icon: 'i-lucide-circle-check' },
  { value: 'host_controlled', label: 'Invited users', description: 'On only for users a host admin turns it on for, from an invite or the user\'s page.', color: 'warning', icon: 'i-lucide-lock' },
  { value: 'disabled', label: 'Disabled', description: 'Hidden from everyone.', color: 'error', icon: 'i-lucide-circle-x' }
]
const personalStatusValue = (s: AppStatus): AppStatus => s === 'available' ? 'host_controlled' : s
const personalStatusMeta = (s: AppStatus) => PERSONAL_STATUS_OPTIONS.find(o => o.value === personalStatusValue(s)) ?? PERSONAL_STATUS_OPTIONS[1]!

const onSetStatus = async (app: AdminApp, status: AppStatus) => {
  if (status === app.status) return
  try {
    await $fetch(`/api/admin/apps/${app.id}`, {
      method: 'PATCH',
      body: { status }
    })
    toast.add({ title: `Status updated to ${status}`, color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  }
}

interface AppOrg {
  id: string
  slug: string
  name: string
  enabled: boolean
  source: 'auto' | 'org_admin' | 'host' | null
}

const orgsApp = ref<AdminApp | null>(null)
const orgsOpen = computed({
  get: () => orgsApp.value !== null,
  set: (v: boolean) => { if (!v) orgsApp.value = null }
})
const appOrgs = ref<AppOrg[]>([])
const appOrgsLoading = ref(false)
const togglingOrgId = ref<string | null>(null)

const loadAppOrgs = async () => {
  if (!orgsApp.value) return
  appOrgsLoading.value = true
  try {
    const res = await $fetch<{ orgs: AppOrg[] }>(`/api/admin/apps/${orgsApp.value.id}/orgs`)
    appOrgs.value = res.orgs
  } finally {
    appOrgsLoading.value = false
  }
}

const openOrgs = async (app: AdminApp) => {
  orgsApp.value = app
  appOrgs.value = []
  await loadAppOrgs()
}

const onToggleOrg = async (org: AppOrg, enabled: boolean) => {
  if (!orgsApp.value) return
  togglingOrgId.value = org.id
  try {
    await $fetch(`/api/admin/orgs/${org.id}/apps/${orgsApp.value.id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' })
    await loadAppOrgs()
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    togglingOrgId.value = null
  }
}

interface AppUser {
  id: string
  display_name: string
  email: string
  granted: boolean
  enabled: boolean
}

// Personal apps are turned on per user: the slideover lists users (those with
// the app first) and flips their grant.
const usersApp = ref<AdminApp | null>(null)
const usersOpen = computed({
  get: () => usersApp.value !== null,
  set: (v: boolean) => { if (!v) usersApp.value = null }
})
const appUsers = ref<AppUser[]>([])
const appUsersTotal = ref(0)
const appUsersStatus = ref<AppStatus | null>(null)
const appUsersLoading = ref(false)
const usersSearch = ref('')
const togglingUserId = ref<string | null>(null)

const loadAppUsers = async () => {
  if (!usersApp.value) return
  appUsersLoading.value = true
  try {
    const res = await $fetch<{ users: AppUser[], total: number, status: AppStatus }>(`/api/admin/apps/${usersApp.value.id}/users`, {
      query: { q: usersSearch.value.trim() || undefined }
    })
    appUsers.value = res.users
    appUsersTotal.value = res.total
    appUsersStatus.value = res.status
  } finally {
    appUsersLoading.value = false
  }
}

const openUsers = async (app: AdminApp) => {
  usersApp.value = app
  usersSearch.value = ''
  appUsers.value = []
  await loadAppUsers()
}

let usersSearchTimer: ReturnType<typeof setTimeout> | null = null
watch(usersSearch, () => {
  if (usersSearchTimer) clearTimeout(usersSearchTimer)
  usersSearchTimer = setTimeout(() => {
    void loadAppUsers()
  }, 250)
})

const onToggleUser = async (user: AppUser, granted: boolean) => {
  if (!usersApp.value) return
  togglingUserId.value = user.id
  try {
    await $fetch(`/api/admin/users/${user.id}/apps/${usersApp.value.id}`, { method: 'PUT', body: { granted } })
    await loadAppUsers()
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    togglingUserId.value = null
  }
}

const removeApp = ref<AdminApp | null>(null)
const removeOpen = computed({
  get: () => removeApp.value !== null,
  set: (v: boolean) => { if (!v) removeApp.value = null }
})
const removing = ref(false)

const onRemove = async () => {
  if (!removeApp.value) return
  removing.value = true
  try {
    await $fetch(`/api/admin/apps/${removeApp.value.id}`, { method: 'DELETE' })
    toast.add({ title: `Removed ${removeApp.value.title}`, color: 'success' })
    removeApp.value = null
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: 'Remove failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <header>
      <h1 class="text-2xl font-bold">
        Apps
      </h1>
      <p class="text-sm text-(--ui-text-muted)">
        <template v-if="tenancyEnabled">
          Set the global availability for each app. Each option is described in the dropdown.
        </template>
        <template v-else>
          Enable or disable each app for this instance.
        </template>
      </p>
    </header>

    <div
      v-if="pending && apps.length === 0"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <ul
      v-else
      class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
    >
      <li
        v-for="app in apps"
        :key="app.id"
        class="flex items-center justify-between gap-3 p-4"
      >
        <div class="flex items-start gap-3 min-w-0">
          <AppIcon
            :name="app.icon"
            class="size-6 mt-1 shrink-0 text-sm"
          />
          <div class="min-w-0">
            <div class="font-medium flex items-center gap-2">
              {{ app.title }}
              <span
                v-if="app.title !== app.id"
                class="text-xs font-normal text-(--ui-text-dimmed)"
              >{{ app.id }}</span>
              <UBadge
                v-if="!app.installed"
                color="warning"
                variant="subtle"
                size="sm"
              >
                Layer not installed
              </UBadge>
              <UBadge
                v-else-if="app.scope === 'user'"
                color="neutral"
                variant="subtle"
                size="sm"
              >
                Personal
              </UBadge>
            </div>
            <div
              v-if="app.description"
              class="text-xs text-(--ui-text-muted)"
            >
              {{ app.description }}
            </div>
          </div>
        </div>
        <UButton
          v-if="!app.installed"
          color="error"
          variant="soft"
          size="sm"
          icon="i-lucide-trash-2"
          class="shrink-0"
          @click="removeApp = app"
        >
          Remove
        </UButton>
        <div
          v-else-if="app.scope === 'user'"
          class="flex items-center gap-2 shrink-0"
        >
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-lucide-users"
            @click="openUsers(app)"
          >
            Users
          </UButton>
          <USelectMenu
            :model-value="personalStatusValue(app.status)"
            :items="PERSONAL_STATUS_OPTIONS"
            value-key="value"
            label-key="label"
            :search="false"
            :color="personalStatusMeta(app.status).color"
            variant="outline"
            size="sm"
            class="w-44 shrink-0"
            @update:model-value="(v: AppStatus) => onSetStatus(app, v)"
          >
            <template #leading>
              <UIcon
                :name="personalStatusMeta(app.status).icon"
                class="size-4"
              />
            </template>
            <template #item="{ item }">
              <div class="flex items-start gap-2 py-0.5">
                <UIcon
                  :name="(item as typeof PERSONAL_STATUS_OPTIONS[number]).icon"
                  class="size-4 mt-0.5 shrink-0"
                />
                <div>
                  <div class="font-medium leading-tight">
                    {{ (item as typeof PERSONAL_STATUS_OPTIONS[number]).label }}
                  </div>
                  <div class="text-xs text-(--ui-text-muted) leading-tight mt-0.5">
                    {{ (item as typeof PERSONAL_STATUS_OPTIONS[number]).description }}
                  </div>
                </div>
              </div>
            </template>
          </USelectMenu>
        </div>
        <!-- Single-tenant: a plain on/off switch. "On" stores `default` (shown
             in the launcher); "off" stores `disabled` (hidden). The `available`
             tier is multi-tenant-only (it means "org admin must opt in"), so it
             isn't offered here. `host_controlled` is multi-tenant-only too and
             reads as off. -->
        <div
          v-else-if="!tenancyEnabled"
          class="flex items-center gap-2 shrink-0"
        >
          <span class="text-sm text-(--ui-text-muted)">
            {{ app.status === 'disabled' || app.status === 'host_controlled' ? 'Disabled' : 'Enabled' }}
          </span>
          <USwitch
            :model-value="app.status !== 'disabled' && app.status !== 'host_controlled'"
            size="lg"
            @update:model-value="(v: boolean) => onSetStatus(app, v ? 'default' : 'disabled')"
          />
        </div>
        <div
          v-else
          class="flex items-center gap-2 shrink-0"
        >
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-lucide-building-2"
            @click="openOrgs(app)"
          >
            Orgs
          </UButton>
          <USelectMenu
            :model-value="app.status"
            :items="STATUS_OPTIONS"
            value-key="value"
            label-key="label"
            :search="false"
            :color="statusMeta(app.status).color"
            variant="outline"
            size="sm"
            class="w-44 shrink-0"
            @update:model-value="(v: AppStatus) => onSetStatus(app, v)"
          >
            <template #leading>
              <UIcon
                :name="statusMeta(app.status).icon"
                class="size-4"
              />
            </template>
            <template #item="{ item }">
              <div class="flex items-start gap-2 py-0.5">
                <UIcon
                  :name="(item as typeof STATUS_OPTIONS[number]).icon"
                  class="size-4 mt-0.5 shrink-0"
                />
                <div>
                  <div class="font-medium leading-tight">
                    {{ (item as typeof STATUS_OPTIONS[number]).label }}
                  </div>
                  <div class="text-xs text-(--ui-text-muted) leading-tight mt-0.5">
                    {{ (item as typeof STATUS_OPTIONS[number]).description }}
                  </div>
                </div>
              </div>
            </template>
          </USelectMenu>
        </div>
      </li>
    </ul>

    <USlideover
      v-model:open="orgsOpen"
      :title="orgsApp ? `${orgsApp.title} — orgs` : ''"
      description="Turn this app on or off per org. Changes made here are marked as set by the host. Org admins can change them unless the app is host controlled."
    >
      <template #body>
        <div
          v-if="appOrgsLoading && appOrgs.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          Loading...
        </div>
        <div
          v-else-if="appOrgs.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          No organizations yet.
        </div>
        <p
          v-else-if="orgsApp?.status === 'disabled'"
          class="text-sm text-(--ui-text-muted) mb-3"
        >
          This app is disabled for every org. Change its status to enable it per org.
        </p>
        <ul
          v-if="appOrgs.length > 0"
          class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
        >
          <li
            v-for="org in appOrgs"
            :key="org.id"
            class="flex items-center justify-between gap-3 p-3"
          >
            <div class="min-w-0">
              <div class="font-medium truncate">
                {{ org.name }}
              </div>
              <div class="text-xs text-(--ui-text-muted)">
                @{{ org.slug }}
                <template v-if="org.source === 'host'">
                  · set by host
                </template>
                <template v-else-if="org.source === 'org_admin'">
                  · set by org admin
                </template>
              </div>
            </div>
            <USwitch
              :model-value="org.enabled"
              :disabled="orgsApp?.status === 'disabled' || togglingOrgId === org.id"
              @update:model-value="(v: boolean) => onToggleOrg(org, v)"
            />
          </li>
        </ul>
      </template>
    </USlideover>

    <USlideover
      v-model:open="usersOpen"
      :title="usersApp ? `${usersApp.title} — users` : ''"
      description="Turn this app on or off for each user. Each user's data stays theirs in every org."
    >
      <template #body>
        <div class="space-y-3">
          <p
            v-if="appUsersStatus === 'default'"
            class="text-sm text-(--ui-text-muted)"
          >
            This app is on for everyone. Set it to Invited users to choose who has it.
          </p>
          <p
            v-else-if="appUsersStatus === 'disabled'"
            class="text-sm text-(--ui-text-muted)"
          >
            This app is disabled for everyone. Set it to Invited users to choose who has it.
          </p>
          <UInput
            v-model="usersSearch"
            icon="i-lucide-search"
            placeholder="Search by name or email"
            class="w-full"
          />
          <div
            v-if="appUsersLoading && appUsers.length === 0"
            class="text-sm text-(--ui-text-muted)"
          >
            Loading...
          </div>
          <div
            v-else-if="appUsers.length === 0"
            class="text-sm text-(--ui-text-muted)"
          >
            No users found.
          </div>
          <ul
            v-else
            class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
          >
            <li
              v-for="u in appUsers"
              :key="u.id"
              class="flex items-center justify-between gap-3 p-3"
            >
              <div class="min-w-0">
                <div class="font-medium truncate">
                  {{ u.display_name || u.email }}
                </div>
                <div class="text-xs text-(--ui-text-muted) truncate">
                  {{ u.email }}
                </div>
              </div>
              <USwitch
                :model-value="u.enabled"
                :disabled="appUsersStatus === 'default' || appUsersStatus === 'disabled' || togglingUserId === u.id"
                @update:model-value="(v: boolean) => onToggleUser(u, v)"
              />
            </li>
          </ul>
          <p
            v-if="appUsersTotal > appUsers.length"
            class="text-xs text-(--ui-text-muted)"
          >
            Showing {{ appUsers.length }} of {{ appUsersTotal }}. Search to find someone else.
          </p>
        </div>
      </template>
    </USlideover>

    <UModal v-model:open="removeOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Remove {{ removeApp?.title }}?
          </h2>
          <p class="text-sm">
            This removes the app from the catalog along with every org's on/off
            setting for it. The app's own data tables are left in place.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              @click="removeApp = null"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="removing"
              @click="onRemove"
            >
              Remove
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
