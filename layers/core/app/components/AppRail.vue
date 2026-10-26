<script setup lang="ts">
import { useActiveOrg } from '#tenant'

// `alwaysExpanded`: the mobile drawer shows names and has no toggle.
const props = defineProps<{ alwaysExpanded?: boolean }>()

const { orgApps, personalApps } = await useApps()
// Org apps first, then personal apps after a divider.
const sections = computed(() => [
  { key: 'org', label: '', links: buildRailLinks(orgApps.value) },
  { key: 'user', label: 'Personal', links: buildRailLinks(personalApps.value) }
].filter(s => s.links.length > 0))
const route = useRoute()
const activeKey = computed(() => matchAppByPath(sections.value.flatMap(s => s.links), route.path)?.key ?? null)
const { isHostAdmin } = usePermissions()
const { slug } = useActiveOrg()

const railConfig = useAppConfig().rail
// The top link: the app launcher by default; a host can point it elsewhere
// with `rail.launcher: { title, icon, path }`, or hide it with `false`.
const launcherConfig = railConfig?.launcher as boolean | { title?: string, icon?: string, path?: string } | undefined
const launcher = computed(() => {
  if (launcherConfig === false) return null
  const custom = typeof launcherConfig === 'object' ? launcherConfig : {}
  return {
    title: custom.title ?? 'All apps',
    icon: custom.icon ?? 'i-lucide-grid-2x2',
    path: custom.path ?? launcherPath(slug.value)
  }
})
const isHome = computed(() => {
  const path = typeof launcherConfig === 'object' ? launcherConfig.path : undefined
  if (!path) return /^\/(@[^/]+\/)?dashboard\/?$/.test(route.path)
  return route.path === path || route.path.startsWith(path + '/')
})
const { expanded: storedExpanded, toggle } = useRailExpanded()
const expanded = computed(() => props.alwaysExpanded || storedExpanded.value)

// OrgSettingsRailLink ships with the tenancy layer; single-tenant builds have
// no org settings, so the rail's bottom slot stays empty.
const orgSettingsLink = useRuntimeConfig().public.tenancy && railConfig?.orgSettings !== false
  ? resolveComponent('OrgSettingsRailLink')
  : null

// Per-app unread badges. Shares the polling loop + state with the bell.
const { byApp, start, stop } = useNotifications()
onMounted(start)
onBeforeUnmount(stop)

const shapeClass = computed(() => expanded.value ? 'h-10 w-full gap-3 px-2.5' : 'size-10 justify-center')
function stateClass(active: boolean) {
  return active
    ? 'bg-(--ui-bg-accented) text-(--ui-text)'
    : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'
}
</script>

<template>
  <aside
    class="flex-col shrink-0 border-r border-(--ui-border) bg-neutral-200 dark:bg-neutral-950 py-3 gap-1"
    :class="expanded ? 'w-56 items-stretch px-2' : 'w-14 items-center'"
  >
    <NuxtLink
      v-if="launcher"
      :to="launcher.path"
      class="flex items-center rounded-md transition-colors"
      :class="[shapeClass, stateClass(isHome)]"
      :title="expanded ? undefined : launcher.title"
      :aria-label="launcher.title"
    >
      <UIcon
        :name="launcher.icon"
        class="size-5 shrink-0"
      />
      <span
        v-if="expanded"
        class="truncate text-sm"
      >{{ launcher.title }}</span>
    </NuxtLink>
    <template
      v-for="(section, i) in sections"
      :key="section.key"
    >
      <USeparator
        v-if="expanded && section.label"
        :label="section.label"
        class="my-1"
      />
      <div
        v-else-if="i > 0 || launcher"
        class="border-t border-(--ui-border) my-1"
        :class="expanded ? 'w-full' : 'w-8'"
      />
      <NuxtLink
        v-for="link in section.links"
        :key="link.key"
        :to="link.path"
        class="relative flex items-center rounded-md transition-colors"
        :class="[shapeClass, stateClass(activeKey === link.key)]"
        :title="expanded ? undefined : link.scope === 'user' ? `${link.title} (personal)` : link.title"
        :aria-label="link.title"
      >
        <AppIcon
          :name="link.icon"
          class="size-5 shrink-0 text-[11px]"
        />
        <span
          v-if="expanded"
          class="truncate text-sm"
        >{{ link.title }}</span>
        <span
          v-if="link.badge && byApp[link.appId]"
          class="rail-badge"
          :class="{ 'rail-badge-inline': expanded }"
        >
          {{ byApp[link.appId]! > 99 ? '99+' : byApp[link.appId] }}
        </span>
      </NuxtLink>
    </template>
    <div
      class="mt-auto flex flex-col gap-1"
      :class="expanded ? 'items-stretch' : 'items-center'"
    >
      <component
        :is="orgSettingsLink"
        v-if="orgSettingsLink"
        :expanded="expanded"
      />
      <NuxtLink
        v-if="isHostAdmin"
        to="/admin"
        class="flex items-center rounded-md transition-colors"
        :class="[shapeClass, stateClass(false)]"
        :title="expanded ? undefined : 'Admin'"
        aria-label="Admin"
      >
        <UIcon
          name="i-lucide-shield-check"
          class="size-5 shrink-0"
        />
        <span
          v-if="expanded"
          class="truncate text-sm"
        >Admin</span>
      </NuxtLink>
      <button
        v-if="!alwaysExpanded"
        type="button"
        class="flex items-center rounded-md transition-colors"
        :class="[shapeClass, stateClass(false)]"
        :title="expanded ? undefined : 'Show names'"
        :aria-expanded="expanded"
        :aria-label="expanded ? 'Hide names' : 'Show names'"
        @click="toggle"
      >
        <UIcon
          :name="expanded ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'"
          class="size-5 shrink-0"
        />
        <span
          v-if="expanded"
          class="truncate text-sm"
        >Hide names</span>
      </button>
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

.rail-badge-inline {
  position: static;
  margin-left: auto;
}
</style>
