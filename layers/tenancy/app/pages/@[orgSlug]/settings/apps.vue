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
}

const { data, pending, refresh } = await useFetch<{ apps: OrgApp[] }>(
  () => `/api/o/${orgSlug.value}/apps`,
  { watch: [orgSlug], default: () => ({ apps: [] }) }
)

const apps = computed(() => data.value?.apps ?? [])

const { refresh: refreshRailApps } = await useApps()

const onToggle = async (app: OrgApp) => {
  if (app.lockedByHost) return
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
      <h1 class="text-3xl font-bold">
        Apps
      </h1>
      <p class="text-sm text-(--ui-text-muted)">
        Choose which apps are available to members of this organization.
      </p>

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
              <div class="text-xs text-(--ui-text-muted) mt-1">
                {{ app.globalStatus === 'host_controlled'
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
          <USwitch
            :model-value="app.enabled"
            :disabled="app.lockedByHost"
            @update:model-value="() => onToggle(app)"
          />
        </li>
      </ul>
    </div>
  </div>
</template>
