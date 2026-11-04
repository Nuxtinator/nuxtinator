<script setup lang="ts">
import type { SidebarNavItem } from '#core/app/utils/sidebar-nav'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const mobileOpen = ref(false)

// Sections optional layers registered for the org settings shell (see core's
// org-settings-section-registry), already permission-filtered server-side.
const { data: registered } = await useFetch<{ sections: { title: string, icon: string, to: string }[] }>(
  () => `/api/o/${orgSlug.value}/_settings-sections`,
  { watch: [orgSlug], default: () => ({ sections: [] }) }
)

const navItems = computed<SidebarNavItem[]>(() => {
  const base = `/@${orgSlug.value}/settings`
  return [
    { to: base, label: 'General', icon: 'i-lucide-settings', exact: true },
    { to: `${base}/members`, label: 'Members', icon: 'i-lucide-users' },
    { to: `${base}/roles`, label: 'Roles', icon: 'i-lucide-shield' },
    { to: `${base}/apps`, label: 'Apps', icon: 'i-lucide-grid-2x2' },
    { to: `${base}/audit`, label: 'Activity', icon: 'i-lucide-history' },
    ...(registered.value?.sections ?? []).map(s => ({ to: s.to, label: s.title, icon: s.icon }))
  ]
})

watch(() => route.path, () => {
  mobileOpen.value = false
})
</script>

<template>
  <div class="sm:flex lg:gap-8 -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <!-- Mobile header -->
    <header class="sm:hidden flex items-center justify-between border-b border-(--ui-border) px-4 py-3">
      <div class="flex items-center gap-2">
        <UButton
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open settings menu"
          @click="mobileOpen = true"
        />
        <h1 class="text-lg font-semibold">
          Settings
        </h1>
      </div>
    </header>

    <!-- Desktop sidebar -->
    <SidebarPanel
      title="Settings"
      class="hidden sm:flex w-64 shrink-0 sticky top-[49px] !h-[calc(100vh-49px)] lg:top-[57px] lg:!h-[calc(100vh-57px)]"
    >
      <SidebarNav :items="navItems" />
    </SidebarPanel>

    <!-- Mobile drawer -->
    <USlideover
      v-model:open="mobileOpen"
      side="left"
      :ui="{ content: 'max-w-xs' }"
    >
      <template #content>
        <SidebarPanel class="border-r-0">
          <template #header>
            <div class="flex items-center justify-between">
              <h1 class="text-xl font-semibold">
                Settings
              </h1>
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                aria-label="Close menu"
                @click="mobileOpen = false"
              />
            </div>
          </template>
          <SidebarNav :items="navItems" />
        </SidebarPanel>
      </template>
    </USlideover>

    <main class="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
      <NuxtPage />
    </main>
  </div>
</template>
