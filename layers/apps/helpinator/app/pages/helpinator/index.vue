<script setup lang="ts">
// Read-only log of help-chat conversations, newest first.
import type { HelpinatorConversationSummary } from '../../utils/helpinator-types'

definePageMeta({ middleware: 'auth' })

const pathTo = useHelpinatorPath()
const { data: status } = useHelpinatorStatus()
const route = useRoute()
// Shares the sidebar's fetch (same key) — no second request.
const { data: widgets } = useFetch<{ id: string, name: string }[]>('/api/helpinator/widgets', {
  key: 'helpinator-sidebar-widgets',
  default: () => []
})

// The channel comes from the sidebar, via `?widget=<id>`.
const widgetId = computed(() => typeof route.query.widget === 'string' ? route.query.widget : 'all')
const state = ref<'all' | 'handed_off' | 'with_email' | 'bot_only'>('all')

const title = computed(() => widgetId.value === 'all'
  ? 'All conversations'
  : widgets.value?.find((w: { id: string, name: string }) => w.id === widgetId.value)?.name ?? 'Conversations')
const stateItems = [
  { label: 'All conversations', value: 'all' },
  { label: 'Sent to inbox', value: 'handed_off' },
  { label: 'Left an email', value: 'with_email' },
  { label: 'Bot only', value: 'bot_only' }
]

const PAGE = 50
const rows = ref<HelpinatorConversationSummary[]>([])
const hasMore = ref(false)
const loading = ref(false)

function query(offset: number) {
  return {
    limit: PAGE,
    offset,
    ...(widgetId.value !== 'all' ? { widgetId: widgetId.value } : {}),
    ...(state.value === 'handed_off' ? { handedOff: 'true' } : {}),
    ...(state.value === 'bot_only' ? { handedOff: 'false' } : {}),
    ...(state.value === 'with_email' ? { hasEmail: 'true' } : {})
  }
}

async function load(reset: boolean) {
  loading.value = true
  try {
    const res = await $fetch<{ conversations: HelpinatorConversationSummary[], hasMore: boolean }>(
      '/api/helpinator/conversations',
      { query: query(reset ? 0 : rows.value.length) }
    )
    rows.value = reset ? res.conversations : [...rows.value, ...res.conversations]
    hasMore.value = res.hasMore
  } finally {
    loading.value = false
  }
}

watch([widgetId, state], () => load(true))
onMounted(() => load(true))

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function pagePath(url: string | null): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url
  }
}
</script>

<template>
  <HelpinatorShell :title="title">
    <template v-if="status?.canManage && widgetId !== 'all'" #title>
      <UButton
        :to="pathTo(`/helpinator/widgets/${widgetId}`)"
        icon="i-lucide-settings"
        variant="ghost"
        color="neutral"
        size="xs"
        aria-label="Widget settings"
        title="Widget settings"
      />
    </template>
    <template #actions>
      <USelect v-model="state" :items="stateItems" size="sm" class="w-44" />
    </template>

    <div class="max-w-5xl mx-auto space-y-6">
      <UAlert
        v-if="status && !status.aiConfigured"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="AI isn't configured"
        description="Widgets show an 'unavailable' message until an OpenRouter key and a model are set up in the AI settings."
      />

      <div v-if="!loading && rows.length === 0" class="text-center py-16 text-(--ui-text-muted)">
        <UIcon name="i-lucide-messages-square" class="size-10 mb-3" />
        <p>No conversations yet.</p>
        <p v-if="status?.canManage" class="text-sm mt-1">
          Create a widget and embed it on a site to get started.
          <NuxtLink :to="pathTo('/helpinator/widgets')" class="text-(--ui-primary) underline">
            Manage widgets
          </NuxtLink>
        </p>
      </div>

      <ul v-else class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-lg overflow-hidden">
        <li v-for="c in rows" :key="c.id">
          <NuxtLink
            :to="pathTo(`/helpinator/conversations/${c.id}`)"
            class="flex gap-4 px-4 py-3 hover:bg-(--ui-bg-elevated) transition-colors"
          >
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">
                {{ c.first_question || '(no messages)' }}
              </p>
              <p class="text-sm text-(--ui-text-muted) truncate">
                {{ c.widget_name }}<span v-if="c.page_url"> · {{ pagePath(c.page_url) }}</span>
                <span v-if="c.visitor_email"> · {{ c.visitor_email }}</span>
              </p>
            </div>
            <div class="flex flex-col items-end gap-1 shrink-0">
              <span class="text-xs text-(--ui-text-muted)">{{ when(c.last_message_at) }}</span>
              <div class="flex gap-1">
                <UBadge v-if="c.inbox_conversation_id" color="success" variant="subtle" size="sm">
                  {{ c.handoff_kind === 'staff' ? 'Elevated' : 'Sent to inbox' }}
                </UBadge>
                <UBadge v-else-if="c.visitor_email" color="info" variant="subtle" size="sm">
                  Email
                </UBadge>
                <UBadge color="neutral" variant="subtle" size="sm">
                  {{ c.visitor_message_count }} {{ c.visitor_message_count === 1 ? 'message' : 'messages' }}
                </UBadge>
              </div>
            </div>
          </NuxtLink>
        </li>
      </ul>

      <div v-if="hasMore" class="flex justify-center">
        <UButton variant="outline" color="neutral" :loading="loading" @click="load(false)">
          Load more
        </UButton>
      </div>
    </div>
  </HelpinatorShell>
</template>
