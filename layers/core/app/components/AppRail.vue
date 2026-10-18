<script setup lang="ts">
import { useActiveOrg } from '#tenant'

const { apps, orgApps, personalApps } = await useApps()
const activeApp = useActiveApp(apps)
// Org apps first, then personal apps after a divider.
const sections = computed(() => [orgApps.value, personalApps.value].filter(list => list.length > 0))
const route = useRoute()
const { isHostAdmin } = usePermissions()
const isHome = computed(() => /^\/(@[^/]+\/)?dashboard\/?$/.test(route.path))
const { slug } = useActiveOrg()
const homePath = computed(() => launcherPath(slug.value))

// OrgSettingsRailLink ships with the tenancy layer; single-tenant builds have
// no org settings, so the rail's bottom slot stays empty.
const orgSettingsLink = useRuntimeConfig().public.tenancy ? resolveComponent('OrgSettingsRailLink') : null

// Per-app unread badges. Shares the polling loop + state with the bell.
const { byApp, start, stop } = useNotifications()
onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <aside class="flex-col items-center w-14 shrink-0 border-r border-(--ui-border) bg-neutral-200 dark:bg-neutral-950 py-3 gap-1">
    <NuxtLink
      :to="homePath"
      class="flex items-center justify-center size-10 rounded-md transition-colors"
      :class="isHome
        ? 'bg-(--ui-bg-accented) text-(--ui-text)'
        : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
      title="All apps"
      aria-label="All apps"
    >
      <UIcon
        name="i-lucide-grid-2x2"
        class="size-5"
      />
    </NuxtLink>
    <template
      v-for="(list, i) in sections"
      :key="i"
    >
      <div class="w-8 border-t border-(--ui-border) my-1" />
      <NuxtLink
        v-for="app in list"
        :key="app.id"
        :to="app.path"
        class="relative flex flex-col items-center justify-center size-10 rounded-md transition-colors"
        :class="activeApp?.id === app.id
          ? 'bg-(--ui-bg-accented) text-(--ui-text)'
          : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
        :title="app.scope === 'user' ? `${app.title} (personal)` : app.title"
        :aria-label="app.title"
      >
        <AppIcon
          :name="app.icon"
          class="size-5 text-[11px]"
        />
        <span
          v-if="byApp[app.id]"
          class="rail-badge"
        >
          {{ byApp[app.id]! > 99 ? '99+' : byApp[app.id] }}
        </span>
      </NuxtLink>
    </template>
    <div
      v-if="orgSettingsLink || isHostAdmin"
      class="mt-auto flex flex-col items-center gap-1"
    >
      <component
        :is="orgSettingsLink"
        v-if="orgSettingsLink"
      />
      <NuxtLink
        v-if="isHostAdmin"
        to="/admin"
        class="flex items-center justify-center size-10 rounded-md text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text) transition-colors"
        title="Admin"
        aria-label="Admin"
      >
        <UIcon
          name="i-lucide-shield-check"
          class="size-5"
        />
      </NuxtLink>
    </div>
  </aside>
</template>

<style scoped>
.rail-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  background: var(--ui-primary);
  color: white;
  font-size: 0.625rem;
  font-weight: 600;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
