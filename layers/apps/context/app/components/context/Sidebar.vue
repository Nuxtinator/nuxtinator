<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const createOpen = ref(false)

const route = useRoute()
watch(() => route.path, () => { open.value = false })

const { hasPermission } = usePermissions()
const canManageSettings = computed(() => hasPermission('context.settings'))
const settingsPath = computed(() => {
  const org = route.params.orgSlug as string | undefined
  return org ? `/@${org}/context/settings` : '/context/settings'
})
const onSettings = computed(() => route.path === settingsPath.value)

// Reviewers always see the Suggestions link; anyone else only while they
// have suggestions of their own open.
const { data: suggestionCount } = useAsyncData(
  'context-suggestions-pending-count',
  () => $fetch<{ count: number, is_reviewer: boolean }>('/api/context/suggestions/pending-count')
)
const showSuggestions = computed(() => !!suggestionCount.value
  && (suggestionCount.value.is_reviewer || suggestionCount.value.count > 0))

function startCreate() {
  open.value = false
  createOpen.value = true
}
</script>

<template>
  <SidebarPanel class="hidden lg:flex w-64 shrink-0">
    <ContextSidebarBody @create="startCreate" />
    <template v-if="canManageSettings || showSuggestions" #footer>
      <ContextSuggestionsNavLink v-if="showSuggestions" :count="suggestionCount?.count ?? 0" />
      <NuxtLink
        v-if="canManageSettings"
        :to="settingsPath"
        class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
        :class="onSettings
          ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
          : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
      >
        <UIcon name="i-lucide-settings" class="size-4 shrink-0" />
        <span>Settings</span>
      </NuxtLink>
    </template>
  </SidebarPanel>

  <USlideover
    v-model:open="open"
    side="left"
    :ui="{ content: 'max-w-xs' }"
  >
    <template #content>
      <SidebarPanel class="border-r-0">
        <template #header>
          <div class="flex items-center justify-between">
            <h1 class="text-xl font-semibold">
              Context
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
        <ContextSidebarBody @navigated="open = false" @create="startCreate" />
        <template v-if="canManageSettings || showSuggestions" #footer>
          <ContextSuggestionsNavLink v-if="showSuggestions" :count="suggestionCount?.count ?? 0" />
          <NuxtLink
            v-if="canManageSettings"
            :to="settingsPath"
            class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition"
            :class="onSettings
              ? 'bg-(--ui-bg-accented) text-(--ui-text) font-medium'
              : 'text-(--ui-text-muted) hover:bg-(--ui-bg-accented) hover:text-(--ui-text)'"
          >
            <UIcon name="i-lucide-settings" class="size-4 shrink-0" />
            <span>Settings</span>
          </NuxtLink>
        </template>
      </SidebarPanel>
    </template>
  </USlideover>

  <ContextCreatePortfolioModal v-model:open="createOpen" />

  <ContextAssistantLauncher />
</template>
