<script setup lang="ts">
import { createReusableTemplate } from '@vueuse/core'
import type { AppCategoryInfo, AppLayout } from '#core/app/utils/app-layout'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()
const confirmAction = useConfirm()
const byCategory = useAppConfig().rail?.categories !== false

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
  order?: number
  category?: string
  /** False for apps with no rail entry, reached from other apps. */
  launcher: boolean
}

const { data, pending, refresh } = await useFetch<{ apps: OrgApp[], categories?: AppCategoryInfo[], layout?: AppLayout }>(
  () => `/api/o/${orgSlug.value}/apps`,
  { watch: [orgSlug], default: () => ({ apps: [] }) }
)

const apps = computed(() => data.value?.apps ?? [])

const { refresh: refreshRailApps } = await useApps()

// Apps in the rail are arranged under categories; the rest are listed after.
const railApps = computed(() => apps.value.filter(a => a.launcher).map(a => ({ ...a, id: a.appId })))
const otherApps = computed(() => apps.value.filter(a => !a.launcher))
const arrangement = useAppArrangement({
  apps: railApps,
  categories: () => data.value?.categories ?? [],
  layout: () => data.value?.layout,
  endpoint: () => `/api/o/${orgSlug.value}/app-layout`,
  onSaved: () => Promise.all([refresh(), refreshRailApps()])
})
const { customized, saving } = arrangement

const onReset = async () => {
  if (!await confirmAction({
    title: 'Reset the app order?',
    description: 'Apps go back to their own categories and order, and the categories added here are removed.',
    confirmLabel: 'Reset'
  })) return
  arrangement.reset()
}

const [DefineRow, ReuseRow] = createReusableTemplate<{ app: OrgApp }>()

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
    <DefineRow v-slot="{ app }">
      <div class="flex items-center justify-between gap-3">
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
      </div>
    </DefineRow>

    <div class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h1 class="text-3xl font-bold">
          Apps
        </h1>
        <div
          v-if="byCategory"
          class="flex items-center gap-2"
        >
          <UButton
            v-if="customized"
            color="error"
            variant="outline"
            icon="i-lucide-rotate-ccw"
            :disabled="saving"
            @click="onReset"
          >
            Reset order
          </UButton>
          <UButton
            icon="i-lucide-plus"
            :disabled="saving"
            @click="arrangement.openAdd()"
          >
            Add category
          </UButton>
        </div>
      </div>
      <p class="text-sm text-(--ui-text-muted)">
        Choose which apps are available to members of this organization.
      </p>

      <div
        v-if="pending && apps.length === 0"
        class="text-sm text-(--ui-text-muted)"
      >
        Loading...
      </div>

      <template v-else-if="byCategory">
        <AppCategoryList :arrangement="arrangement">
          <template #row="{ app }">
            <ReuseRow :app="app" />
          </template>
        </AppCategoryList>
        <UCard
          v-if="otherApps.length > 0"
          :ui="{ body: 'p-0 sm:p-0' }"
        >
          <template #header>
            <h2 class="font-semibold">
              Opened from other apps
            </h2>
          </template>
          <ul class="divide-y divide-(--ui-border)">
            <li
              v-for="app in otherApps"
              :key="app.appId"
              class="p-4"
            >
              <ReuseRow :app="app" />
            </li>
          </ul>
        </UCard>
      </template>

      <ul
        v-else
        class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
      >
        <li
          v-for="app in apps"
          :key="app.appId"
          class="p-4"
        >
          <ReuseRow :app="app" />
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
