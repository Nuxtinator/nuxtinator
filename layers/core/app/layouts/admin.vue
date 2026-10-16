<script setup lang="ts">
import type { SidebarNavItem } from '#core/app/utils/sidebar-nav'

const route = useRoute()
const mobileOpen = ref(false)

const { sections } = await useAdminSections()

// Build a two-level tree from the flat section list. Sections with a
// `parent` matching another section's `path` render indented underneath
// that parent. Anything with an unknown parent path is hoisted to the
// top level so it isn't silently swallowed.
const navItems = computed<SidebarNavItem[]>(() => {
  const all = sections.value
  const validParents = new Set(all.map(s => s.path))
  const childrenByParent = new Map<string, SidebarNavItem[]>()
  for (const s of all) {
    if (s.parent && validParents.has(s.parent)) {
      const arr = childrenByParent.get(s.parent) ?? []
      arr.push({ to: s.path, label: s.title, icon: s.icon ?? 'i-lucide-circle' })
      childrenByParent.set(s.parent, arr)
    }
  }
  return all
    .filter(s => !s.parent || !validParents.has(s.parent))
    .map(s => ({
      to: s.path,
      label: s.title,
      icon: s.icon ?? 'i-lucide-circle',
      exact: s.path === '/admin',
      children: childrenByParent.get(s.path)
    }))
})

watch(() => route.path, () => {
  mobileOpen.value = false
})
</script>

<template>
  <div class="min-h-screen bg-(--ui-bg) text-(--ui-text)">
    <header class="h-14 bg-(--chrome-bg) border-b border-(--ui-border) px-4 sticky top-0 z-40 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <UButton
          class="sm:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          aria-label="Open menu"
          @click="mobileOpen = true"
        />
        <span class="text-lg font-semibold">Admin</span>
      </div>
      <UButton
        :to="launcherPath()"
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
      >
        Back to app
      </UButton>
    </header>

    <div class="sm:flex">
      <!-- Desktop sidebar -->
      <SidebarPanel class="hidden sm:flex w-64 shrink-0 sticky top-14 !h-[calc(100vh-3.5rem)]">
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
                  Admin
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
        <slot />
      </main>
    </div>
  </div>
</template>
