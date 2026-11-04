<script setup lang="ts">
// App-wide Context settings for the active org. Gated on `context.settings`,
// which only the admin role holds by default.
definePageMeta({ middleware: 'auth' })

const sidebarOpen = ref(false)

const { hasPermission, pending } = usePermissions()
const canManage = computed(() => hasPermission('context.settings'))
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <ContextSidebar v-model:open="sidebarOpen" />

    <section class="flex-1 flex flex-col min-w-0 border-l-0 lg:border-l border-(--ui-border) overflow-hidden">
      <header class="flex items-center gap-2 px-3 py-2 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open sidebar"
          @click="sidebarOpen = true"
        />
        <h1 class="font-semibold">
          Context settings
        </h1>
      </header>

      <div class="flex-1 overflow-auto p-6">
        <div class="max-w-2xl mx-auto space-y-8">
          <section v-if="canManage" class="space-y-4">
            <h2 class="text-lg font-semibold">
              Portfolio order
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Drag a portfolio, or use the arrows, to change the order it appears in for everyone
              in this organization. Until an order is set, portfolios are listed alphabetically;
              after that, new portfolios are added at the end.
            </p>
            <ContextPortfolioOrder />
          </section>
          <p v-else-if="!pending" class="text-sm text-(--ui-text-muted)">
            Only an admin can change Context settings.
          </p>
        </div>
      </div>
    </section>
  </div>
</template>
