<script setup lang="ts">
// Every library in the org: the content sets widgets may search and read.
import type { HelpinatorLibrarySummary } from '../../../utils/helpinator-types'
import { helpinatorFormatBytes } from '../../../utils/helpinator-types'

definePageMeta({ middleware: 'auth' })

const pathTo = useHelpinatorPath()
const { data: status } = useHelpinatorStatus()
const { data: libraries, pending } = useFetch<HelpinatorLibrarySummary[]>('/api/helpinator/libraries', { default: () => [] })
</script>

<template>
  <HelpinatorShell title="Libraries">
    <template #actions>
      <UButton v-if="status?.canManage" :to="pathTo('/helpinator/libraries/new')" icon="i-lucide-plus" size="sm">
        New library
      </UButton>
    </template>

    <div class="max-w-5xl mx-auto space-y-6">
      <UAlert
        v-if="status && !status.canManage"
        color="warning"
        variant="subtle"
        title="You don't have permission to manage libraries."
      />

      <p class="text-sm text-(--ui-text-muted)">
        A library is content a widget's assistant can search and read: a <strong>website</strong> crawled
        from a list of URLs, or a context <strong>portfolio</strong> your team writes. A widget lists the
        libraries it may use and keeps one as its default.
      </p>

      <div v-if="!pending && libraries.length === 0" class="text-center py-16 text-(--ui-text-muted)">
        <UIcon name="i-lucide-library" class="size-10 mb-3" />
        <p>No libraries yet. Create one, then pick it on a widget.</p>
      </div>

      <ul v-else class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-lg overflow-hidden">
        <li v-for="l in libraries" :key="l.id">
          <NuxtLink
            :to="pathTo(`/helpinator/libraries/${l.id}`)"
            class="flex items-center gap-4 px-4 py-3 hover:bg-(--ui-bg-elevated) transition-colors"
          >
            <UIcon :name="l.kind === 'website' ? 'i-lucide-globe' : 'i-lucide-book-open-text'" class="size-5 shrink-0 text-(--ui-text-muted)" />
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">
                {{ l.name }}
              </p>
              <p class="text-sm text-(--ui-text-muted) truncate">
                <template v-if="l.kind === 'website'">
                  {{ l.source_count }} {{ l.source_count === 1 ? 'URL' : 'URLs' }} · {{ l.stats.pages }} pages ·
                  {{ helpinatorFormatBytes(l.stats.bytes) }} · {{ l.stats.chunks }} chunks
                </template>
                <template v-else>
                  Portfolio<span v-if="!l.portfolio_id"> (missing — the portfolio was deleted)</span>
                </template>
                <span v-if="l.description"> · {{ l.description }}</span>
              </p>
            </div>
            <UBadge color="neutral" variant="subtle">
              {{ l.kind }}
            </UBadge>
          </NuxtLink>
        </li>
      </ul>
    </div>
  </HelpinatorShell>
</template>
