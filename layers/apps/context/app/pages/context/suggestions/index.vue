<script setup lang="ts">
// Review queue for suggested section updates. Reviewers see every set in the
// org; everyone else sees only the suggestions they made.
import { CONTEXT_SUGGESTION_STATUSES, type ContextSuggestionStatus } from '../../../utils/suggestion-status'

definePageMeta({ middleware: 'auth' })

interface SetSummary {
  id: string
  portfolio_slug: string
  portfolio_name: string
  author_name: string | null
  note: string | null
  created_at: string
  counts: Partial<Record<ContextSuggestionStatus, number>>
  stale_count: number
  sections: Array<{ key: string, title: string, status: ContextSuggestionStatus }>
}

const sidebarOpen = ref(false)
const state = ref<'open' | 'closed'>('open')

const { hasPermission } = usePermissions()
const canReview = computed(() => hasPermission('context.suggestion.review'))

const { data, pending } = await useAsyncData(
  () => `context-suggestions-${state.value}`,
  () => $fetch<{ sets: SetSummary[] }>('/api/context/suggestions', { query: { state: state.value } }),
  { watch: [state] }
)
const sets = computed(() => data.value?.sets ?? [])
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
        <h1 class="font-semibold flex-1">
          Suggestions
        </h1>
        <div class="flex items-center gap-1">
          <UButton
            size="sm"
            color="neutral"
            :variant="state === 'open' ? 'soft' : 'ghost'"
            @click="state = 'open'"
          >
            Open
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            :variant="state === 'closed' ? 'soft' : 'ghost'"
            @click="state = 'closed'"
          >
            Closed
          </UButton>
        </div>
      </header>

      <div class="flex-1 overflow-auto p-6">
        <div class="max-w-3xl mx-auto space-y-3">
          <p class="text-sm text-(--ui-text-muted)">
            {{ canReview
              ? 'Section updates suggested through MCP wait here until they are approved or rejected.'
              : 'Section updates you suggested through MCP wait here until an admin reviews them.' }}
          </p>

          <p v-if="!pending && sets.length === 0" class="text-sm text-(--ui-text-muted) italic py-6 text-center">
            {{ state === 'open' ? 'Nothing waiting for review.' : 'No decided suggestions yet.' }}
          </p>

          <NuxtLink
            v-for="set in sets"
            :key="set.id"
            :to="`/context/suggestions/${set.id}`"
            class="block border border-(--ui-border) rounded-lg p-4 hover:bg-(--ui-bg-elevated) transition"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ set.portfolio_name }}</span>
              <span class="text-sm text-(--ui-text-muted)">
                · {{ set.author_name ?? 'Unknown' }} · {{ new Date(set.created_at).toLocaleString() }}
              </span>
              <span class="flex-1" />
              <UBadge
                v-if="set.stale_count > 0"
                color="warning"
                variant="subtle"
                size="sm"
                icon="i-lucide-triangle-alert"
              >
                {{ set.stale_count }} changed since
              </UBadge>
            </div>
            <p v-if="set.note" class="mt-1 text-sm line-clamp-2">
              {{ set.note }}
            </p>
            <div class="mt-2 flex flex-wrap gap-1">
              <UBadge
                v-for="s in set.sections"
                :key="s.key"
                :color="CONTEXT_SUGGESTION_STATUSES[s.status].color"
                :icon="CONTEXT_SUGGESTION_STATUSES[s.status].icon"
                variant="subtle"
                size="sm"
              >
                {{ s.title }}
              </UBadge>
            </div>
          </NuxtLink>
        </div>
      </div>
    </section>
  </div>
</template>
