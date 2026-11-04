<script setup lang="ts">
// Every help widget in the org — one per site.
import type { HelpinatorWidget, HelpinatorLibrarySummary } from '../../../utils/helpinator-types'

definePageMeta({ middleware: 'auth' })

const pathTo = useHelpinatorPath()
const { data: status } = useHelpinatorStatus()
const { data: widgets, pending } = useFetch<HelpinatorWidget[]>('/api/helpinator/widgets', { default: () => [] })
const { data: libraries } = useFetch<HelpinatorLibrarySummary[]>('/api/helpinator/libraries', { default: () => [] })

const libraryName = (id: string | null) => libraries.value?.find((l: HelpinatorLibrarySummary) => l.id === id)?.name ?? null
const librariesLabel = (w: HelpinatorWidget) => {
  const def = libraryName(w.default_library_id)
  if (!def) return 'No libraries (unavailable)'
  const extra = w.library_ids.length - 1
  return extra > 0 ? `${def} + ${extra} more` : def
}
</script>

<template>
  <HelpinatorShell title="Widgets">
    <template #actions>
      <UButton v-if="status?.canManage" :to="pathTo('/helpinator/widgets/new')" icon="i-lucide-plus" size="sm">
        New widget
      </UButton>
    </template>

    <div class="max-w-5xl mx-auto space-y-6">
      <UAlert
        v-if="status && !status.inboxAvailable"
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        title="Handoff is off"
        description="The inbox app isn't installed on this deployment, so widgets won't offer 'Still need help?'."
      />

      <div v-if="!pending && widgets.length === 0" class="text-center py-16 text-(--ui-text-muted)">
        <UIcon name="i-lucide-app-window" class="size-10 mb-3" />
        <p>No widgets yet. Create one for each site you want to add help chat to.</p>
      </div>

      <ul v-else class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-lg overflow-hidden">
        <li v-for="w in widgets" :key="w.id">
          <NuxtLink
            :to="pathTo(`/helpinator/widgets/${w.id}`)"
            class="flex items-center gap-4 px-4 py-3 hover:bg-(--ui-bg-elevated) transition-colors"
          >
            <span class="size-4 rounded-full shrink-0" :style="{ background: w.appearance.primary_color ?? w.appearance_defaults.primary_color }" />
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">
                {{ w.name }}
              </p>
              <p class="text-sm text-(--ui-text-muted) truncate">
                {{ librariesLabel(w) }}
                · {{ w.allowed_origins.length ? w.allowed_origins.join(', ') : 'no sites allowed yet' }}
              </p>
            </div>
            <UBadge v-if="w.chat_model_unavailable" color="warning" variant="subtle" icon="i-lucide-triangle-alert">
              Model unavailable
            </UBadge>
            <UBadge :color="w.enabled && w.library_ids.length ? 'success' : 'neutral'" variant="subtle">
              {{ w.enabled && w.library_ids.length ? 'Live' : 'Off' }}
            </UBadge>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </HelpinatorShell>
</template>
