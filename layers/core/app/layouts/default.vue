<script setup lang="ts">
const { user } = useAuth()
const config = useRuntimeConfig()

// OrgSwitcher ships with the tenancy layer and doesn't exist in single-tenant
// builds. Resolve it only when tenancy is loaded so Vue doesn't warn about an
// unresolvable component; in single-tenant mode it renders nothing.
const orgSwitcher = config.public.tenancy ? resolveComponent('OrgSwitcher') : null

const { apps } = await useApps()
const activeApp = useActiveApp(apps)
const route = useRoute()

const mobileSidebarOpen = ref(false)
const mobileRailOpen = ref(false)

watch(() => route.path, () => {
  mobileSidebarOpen.value = false
  mobileRailOpen.value = false
})
</script>

<template>
  <div class="min-h-screen bg-(--ui-bg) text-(--ui-text)">
    <!-- Authenticated chrome -->
    <template v-if="user">
      <!-- Mobile top bar -->
      <header class="lg:hidden sticky top-0 z-40 bg-(--chrome-bg) border-b border-(--ui-border) py-2 px-3 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <UButton
            class="sm:hidden"
            icon="i-lucide-grid-2x2"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Open app launcher"
            @click="mobileRailOpen = true"
          />
          <UButton
            v-if="activeApp"
            icon="i-lucide-menu"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Open sidebar"
            @click="mobileSidebarOpen = true"
          />
          <component
            :is="orgSwitcher"
            v-if="orgSwitcher"
          />
          <NuxtLink
            to="/"
            class="text-base font-semibold truncate"
          >
            {{ activeApp?.title || config.public.appName }}
          </NuxtLink>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <NotificationBell :active-app-id="activeApp?.id" />
          <ThemeToggle size="sm" />
          <UButton
            to="/account"
            icon="i-lucide-user"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Account"
            :title="user?.display_name || user?.email"
          />
        </div>
      </header>

      <!-- Desktop top bar -->
      <!-- OrgSwitcher lives in the left group so it sits visually above the
           AppRail (which starts at `w-14` directly below the header). -->
      <header class="hidden lg:flex sticky top-0 z-40 bg-(--chrome-bg) border-b border-(--ui-border) py-3 px-4 items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <component
            :is="orgSwitcher"
            v-if="orgSwitcher"
          />
          <NuxtLink
            to="/"
            class="text-xl font-semibold hover:text-(--ui-text-muted) transition-colors truncate"
          >
            {{ config.public.appName }}
          </NuxtLink>
        </div>
        <div class="flex items-center gap-3">
          <NotificationBell :active-app-id="activeApp?.id" />
          <ThemeToggle size="sm" />
          <UButton
            to="/account"
            icon="i-lucide-user"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Account"
            :title="user?.display_name || user?.email"
          />
        </div>
      </header>

      <div class="flex">
        <AppRail class="hidden sm:flex sticky top-[49px] h-[calc(100vh-49px)] lg:top-[57px] lg:h-[calc(100vh-57px)]" />

        <aside
          v-if="activeApp"
          class="hidden lg:flex w-64 shrink-0 border-r border-(--ui-border) sticky top-[57px] h-[calc(100vh-57px)]"
        >
          <AppSidebar
            :key="activeApp.id"
            :app="activeApp"
            class="w-full"
          />
        </aside>

        <main class="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          <slot />
        </main>
      </div>

      <!-- Mobile app rail drawer -->
      <USlideover
        v-model:open="mobileRailOpen"
        side="left"
        :ui="{ content: 'w-auto max-w-none' }"
      >
        <template #content>
          <AppRail class="flex h-full" />
        </template>
      </USlideover>

      <!-- Mobile sidebar drawer -->
      <USlideover
        v-if="activeApp"
        v-model:open="mobileSidebarOpen"
        side="left"
        :ui="{ content: 'max-w-xs' }"
      >
        <template #content>
          <AppSidebar
            :key="activeApp.id"
            :app="activeApp"
          />
        </template>
      </USlideover>
    </template>

    <!-- Unauthenticated -->
    <template v-else>
      <header class="bg-(--chrome-bg) border-b border-(--ui-border) py-4 sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-4 flex justify-between items-center">
          <NuxtLink
            to="/"
            class="text-xl font-semibold hover:text-(--ui-text-muted) transition-colors"
          >
            {{ config.public.appName }}
          </NuxtLink>
          <ThemeToggle />
        </div>
      </header>
      <main class="max-w-7xl mx-auto px-4 py-8">
        <slot />
      </main>
    </template>
  </div>
</template>
