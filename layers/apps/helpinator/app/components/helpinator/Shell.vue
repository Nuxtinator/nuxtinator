<script setup lang="ts">
// Page frame for every helpinator page: the app's own sidebar (docked on
// desktop, a slide-over on mobile) beside a scrolling content column. Drawn by
// the app rather than core's shared app sidebar, like the context app.
defineProps<{
  title: string
  activeWidgetId?: string | null
}>()

const route = useRoute()
const open = ref(false)
watch(() => route.fullPath, () => {
  open.value = false
})
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <SidebarPanel class="hidden lg:flex w-64 shrink-0">
      <template #header>
        <h1 class="text-xl font-semibold">
          Helpinator
        </h1>
      </template>
      <HelpinatorSidebarBody :active-widget-id="activeWidgetId" />
    </SidebarPanel>

    <USlideover v-model:open="open" side="left" :ui="{ content: 'max-w-xs' }">
      <template #content>
        <SidebarPanel class="border-r-0">
          <template #header>
            <div class="flex items-center justify-between">
              <h1 class="text-xl font-semibold">
                Helpinator
              </h1>
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                aria-label="Close menu"
                @click="open = false"
              />
            </div>
          </template>
          <HelpinatorSidebarBody :active-widget-id="activeWidgetId" @navigated="open = false" />
        </SidebarPanel>
      </template>
    </USlideover>

    <section class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header class="flex items-center gap-2 px-4 sm:px-6 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open sidebar"
          @click="open = true"
        />
        <div class="flex items-center gap-1 min-w-0 flex-1">
          <h1 class="font-semibold truncate">
            {{ title }}
          </h1>
          <slot name="title" />
        </div>
        <slot name="actions" />
      </header>
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6">
        <slot />
      </div>
    </section>
  </div>
</template>
