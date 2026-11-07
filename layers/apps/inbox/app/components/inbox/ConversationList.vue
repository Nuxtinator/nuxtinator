<script setup lang="ts">
// The middle pane: search, status strip, conversation rows. Selection is
// route-driven — clicking a row navigates to /inbox/:id (org prefix
// preserved by the router guard via useRecordsPath).
import type { InboxConversationListRow, InboxCounts, InboxScope } from '../../composables/useInboxConversations'
import type { InboxTag } from '../../composables/useInboxTags'

const props = defineProps<{
  items: InboxConversationListRow[]
  counts: InboxCounts | null
  pending: boolean
  scope: InboxScope
  selectedId: string | null
  palette: InboxTag[]
}>()

// Resolve a stored slug to its palette entry so a row chip shows the current
// name/colour; a slug missing from the palette falls back to a neutral chip.
const tagBySlug = computed(() => {
  const map = new Map<string, InboxTag>()
  for (const t of props.palette) map.set(t.slug, t)
  return map
})
function rowTags(slugs: string[]): InboxTag[] {
  return slugs.map(s => tagBySlug.value.get(s) ?? { slug: s, name: s, color: 'neutral' as const })
}
// Rows carry a status badge only on the All tab; elsewhere every row shares it.
function hasMeta(c: InboxConversationListRow): boolean {
  return status.value === 'all' || c.needsReview || c.messageCount === 0 || c.tags.length > 0 || !!c.assigneeName
}

const status = defineModel<string>('status', { required: true })
const q = defineModel<string>('q', { required: true })
// Bulk selection — the checked ids. Parent-owned: the bulk bar acts on them
// and clears them when the list context changes.
const selectedIds = defineModel<Set<string>>('selectedIds', { default: () => new Set<string>() })

function toggleSelected(id: string) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

const emit = defineEmits<{ select: [id: string] }>()

const statusTabs = computed(() => [
  { key: 'open', label: 'Open', count: props.counts?.open },
  { key: 'pending', label: 'Pending', count: props.counts?.pending },
  { key: 'closed', label: 'Closed' },
  { key: 'spam', label: 'Spam' },
  { key: 'all', label: 'All' }
])
</script>

<template>
  <div class="w-full lg:w-96 shrink-0 flex flex-col min-h-0 border-r border-(--ui-border)">
    <div class="px-2 pt-2 border-b border-(--ui-border)">
      <UInput
        v-model="q"
        icon="i-lucide-search"
        placeholder="Search"
        size="sm"
        variant="soft"
        class="w-full"
      />
      <nav class="flex gap-3 px-1 mt-1 overflow-x-auto">
        <button
          v-for="tab in statusTabs"
          :key="tab.key"
          type="button"
          class="flex items-center gap-1 py-2 text-xs whitespace-nowrap border-b-2 -mb-px transition-colors"
          :class="status === tab.key
            ? 'border-(--ui-primary) text-(--ui-text-highlighted) font-medium'
            : 'border-transparent text-(--ui-text-muted) hover:text-(--ui-text)'"
          @click="status = tab.key"
        >
          {{ tab.label }}
          <span v-if="tab.count" class="text-(--ui-text-dimmed) font-normal">{{ tab.count }}</span>
        </button>
      </nav>
    </div>

    <div class="flex-1 overflow-y-auto">
      <UEmpty
        v-if="!pending && items.length === 0"
        icon="i-lucide-inbox"
        title="No conversations"
        description="Nothing matches this view."
        variant="naked"
        class="mt-10"
      />
      <div
        v-for="c in items"
        :key="c.id"
        class="group flex items-start gap-2 px-3 py-2.5 border-b border-(--ui-border) transition-colors"
        :class="selectedId === c.id ? 'bg-(--ui-bg-accented)' : 'hover:bg-(--ui-bg-accented)/50'"
      >
        <!-- The checkbox stays hidden until the row is hovered or a selection
             is underway; touch screens have no hover, so it always shows there. -->
        <span
          class="pt-0.5 shrink-0 transition-opacity [@media(hover:none)]:opacity-100"
          :class="selectedIds.size ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'"
        >
          <UCheckbox
            :model-value="selectedIds.has(c.id)"
            aria-label="Select conversation"
            @update:model-value="toggleSelected(c.id)"
          />
        </span>
        <button
          type="button"
          class="flex-1 min-w-0 text-left"
          @click="emit('select', c.id)"
        >
          <div class="flex items-center gap-2">
            <UTooltip v-if="INBOX_SOURCE_META[c.source]" :text="INBOX_SOURCE_META[c.source]!.label">
              <UIcon :name="INBOX_SOURCE_META[c.source]!.icon" class="size-3.5 shrink-0 text-(--ui-text-dimmed)" />
            </UTooltip>
            <span class="font-medium text-sm truncate flex-1 text-(--ui-text-highlighted)">
              {{ c.counterpartyName || c.channelValue }}
            </span>
            <span class="text-xs text-(--ui-text-dimmed) shrink-0">{{ inboxRelativeTime(c.lastMessageAt || c.createdAt) }}</span>
          </div>
          <div class="text-sm truncate text-(--ui-text)">{{ c.subject || '(no subject)' }}</div>
          <p v-if="c.snippet" class="text-xs text-(--ui-text-dimmed) truncate mt-0.5">{{ c.snippet }}</p>
          <div v-if="hasMeta(c)" class="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <UBadge
              v-if="status === 'all'"
              :label="INBOX_STATUS_META[c.status]?.label ?? c.status"
              :color="INBOX_STATUS_META[c.status]?.color ?? 'neutral'"
              size="sm"
              variant="subtle"
            />
            <UBadge v-if="c.needsReview" label="Review" color="warning" size="sm" variant="subtle" icon="i-lucide-shield-alert" />
            <UBadge v-if="c.messageCount === 0" label="No message" color="error" size="sm" variant="subtle" />
            <span
              v-for="t in rowTags(c.tags)"
              :key="t.slug"
              class="flex items-center gap-1 text-xs text-(--ui-text-muted)"
            >
              <span class="size-1.5 rounded-full" :style="{ backgroundColor: inboxTagDotColor(t.color) }" />
              {{ t.name }}
            </span>
            <span v-if="c.assigneeName" class="flex items-center gap-1 text-xs text-(--ui-text-dimmed) truncate ml-auto">
              <UIcon name="i-lucide-user" class="size-3 shrink-0" />
              {{ c.assigneeName }}
            </span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
