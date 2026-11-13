<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()

interface OrgApp {
  appId: string
  title: string
  description?: string
  icon?: string
  globalStatus: 'disabled' | 'available' | 'default' | 'host_controlled'
  enabled: boolean
  source: 'auto' | 'org_admin' | 'host' | null
  lockedByHost: boolean
  /** Enabled apps that keep this one on. */
  requiredBy: string[]
  groups: string[]
}

const { data, pending, refresh } = await useFetch<{ apps: OrgApp[] }>(
  () => `/api/o/${orgSlug.value}/apps`,
  { watch: [orgSlug], default: () => ({ apps: [] }) }
)

const apps = computed(() => data.value?.apps ?? [])

const { refresh: refreshRailApps } = await useApps()

const teamsApp = ref<OrgApp | null>(null)
const teamsOpen = computed({
  get: () => teamsApp.value !== null,
  set: (v: boolean) => { if (!v) teamsApp.value = null }
})

const onTeamsSaved = async () => {
  invalidateAppAccess(orgSlug.value)
  await Promise.all([refresh(), refreshRailApps()])
}

const onToggle = async (app: OrgApp) => {
  if (app.lockedByHost || app.requiredBy.length > 0) return
  const verb = app.enabled ? 'disable' : 'enable'
  try {
    await $fetch(`/api/o/${orgSlug.value}/apps/${app.appId}/${verb}`, { method: 'POST' })
    invalidateAppAccess(orgSlug.value)
    await Promise.all([refresh(), refreshRailApps()])
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  }
}
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <div class="space-y-4">
      <PageTitle
        title="Apps"
        help="Choose which apps are available to members of this organization."
      />

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
          :key="app.appId"
          class="flex items-center justify-between gap-3 p-4"
        >
          <div class="min-w-0 flex items-start gap-3">
            <AppIcon
              :name="app.icon"
              class="size-6 mt-1 shrink-0 text-sm"
            />
            <div class="min-w-0">
              <div class="font-medium">
                {{ app.title }}
              </div>
              <div
                v-if="app.description"
                class="text-xs text-(--ui-text-muted)"
              >
                {{ app.description }}
              </div>
              <div
                v-if="app.groups.length > 0"
                class="text-xs text-(--ui-text-muted) mt-1"
              >
                Only for {{ app.groups.join(', ') }}
              </div>
              <div class="text-xs text-(--ui-text-muted) mt-1">
                {{ app.requiredBy.length > 0
                  ? `Required by ${app.requiredBy.join(', ')}`
                  : app.globalStatus === 'host_controlled'
                    ? 'Managed by host'
                    : app.lockedByHost
                      ? 'Disabled by host'
                      : app.source === 'host'
                        ? 'Set by host'
                        : `Default: ${app.globalStatus}`
                }}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <UButton
              v-if="app.enabled"
              variant="outline"
              color="neutral"
              size="sm"
              icon="i-lucide-users"
              @click="teamsApp = app"
            >
              Groups
            </UButton>
            <USwitch
              :model-value="app.enabled"
              :disabled="app.lockedByHost || app.requiredBy.length > 0"
              @update:model-value="() => onToggle(app)"
            />
          </div>
        </li>
      </ul>
    </div>

    <AppGroupsModal
      v-model:open="teamsOpen"
      :endpoint="teamsApp ? `/api/o/${orgSlug}/apps/${teamsApp.appId}/groups` : null"
      :title="teamsApp ? `Who can open ${teamsApp.title}` : ''"
      @saved="onTeamsSaved"
    />
  </div>
</template>
