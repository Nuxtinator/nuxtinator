<script setup lang="ts">
// One help-chat transcript, read-only.
import type { HelpinatorConversationSummary, HelpinatorListState, HelpinatorTranscriptMessage } from '../../../utils/helpinator-types'
import { helpinatorErrorMessage, helpinatorListFilter } from '../../../utils/helpinator-types'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const pathTo = useHelpinatorPath()
const id = computed(() => String(route.params.id))

const { data: status } = useHelpinatorStatus()
const { data, error } = useFetch<{
  conversation: HelpinatorConversationSummary
  messages: HelpinatorTranscriptMessage[]
}>(() => `/api/helpinator/conversations/${id.value}`)

// Previous/next follow the list this transcript was opened from: its channel
// (`?widget=`) and state (`?state=`), newest first.
const LIST_STATES: HelpinatorListState[] = ['all', 'handed_off', 'with_email', 'bot_only']
const listWidget = computed(() => typeof route.query.widget === 'string' ? route.query.widget : 'all')
const listState = computed<HelpinatorListState>(() => {
  const s = route.query.state
  return LIST_STATES.includes(s as HelpinatorListState) ? s as HelpinatorListState : 'all'
})
const { data: neighbors } = useFetch<{ prevId: string | null, nextId: string | null }>(
  () => `/api/helpinator/conversations/${id.value}/neighbors`,
  { query: computed(() => helpinatorListFilter(listWidget.value, listState.value)) }
)

function siblingLink(siblingId: string | null | undefined) {
  if (!siblingId) return undefined
  return { path: pathTo(`/helpinator/conversations/${siblingId}`), query: route.query }
}

const conversation = computed(() => data.value?.conversation)
// The server only stores http(s) page URLs; older rows may hold anything, so
// only those render as a link.
const pageHref = computed(() => /^https?:\/\//i.test(conversation.value?.page_url ?? '') ? conversation.value!.page_url! : null)

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

// Hits the bot also loaded already show under "pages read".
function unreadHits(m: HelpinatorTranscriptMessage) {
  return m.search_hits.filter(h => !m.pages_loaded.some(p => p.ref === h.ref))
}

function inboxLink(inboxId: string): string {
  return pathTo(`/inbox/${inboxId}`)
}
</script>

<template>
  <HelpinatorShell title="Conversation" :active-widget-id="conversation?.widget_id">
    <template #actions>
      <UButton
        :to="siblingLink(neighbors?.prevId)"
        :disabled="!neighbors?.prevId"
        icon="i-lucide-chevron-left"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Previous conversation"
        title="Previous (newer) conversation"
      />
      <UButton
        :to="siblingLink(neighbors?.nextId)"
        :disabled="!neighbors?.nextId"
        icon="i-lucide-chevron-right"
        variant="ghost"
        color="neutral"
        size="sm"
        aria-label="Next conversation"
        title="Next (older) conversation"
      />
    </template>
    <div class="max-w-5xl mx-auto space-y-4">
      <UAlert v-if="error" color="error" variant="subtle" :title="helpinatorErrorMessage(error)" />

      <div v-if="conversation" class="grid gap-6 lg:grid-cols-[1fr_280px]">
        <section class="space-y-3 min-w-0">
          <div
            v-for="m in data!.messages"
            :key="m.id"
            class="flex"
            :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[85%] rounded-xl px-4 py-2.5 text-sm"
              :class="m.role === 'user'
                ? 'bg-(--ui-primary) text-(--ui-bg) rounded-br-sm whitespace-pre-wrap'
                : 'bg-(--ui-bg-elevated) rounded-bl-sm'"
            >
              <template v-if="m.role === 'user'">
                {{ m.content }}
              </template>
              <template v-else>
                <HelpinatorMarkdown :text="m.content" />
                <div v-if="m.searches.length" class="mt-2 flex flex-wrap items-center gap-1">
                  <UIcon name="i-lucide-search" class="size-3.5 text-(--ui-text-dimmed)" />
                  <UBadge
                    v-for="(q, i) in m.searches"
                    :key="i"
                    color="neutral"
                    variant="soft"
                    size="sm"
                  >
                    {{ q }}
                  </UBadge>
                </div>
                <div v-if="m.pages_loaded.length" class="mt-2 flex flex-wrap items-center gap-1" title="Pages read in full">
                  <UIcon name="i-lucide-book-open" class="size-3.5 text-(--ui-text-dimmed)" />
                  <component
                    :is="p.url ? 'a' : 'span'"
                    v-for="p in m.pages_loaded"
                    :key="p.ref"
                    v-bind="p.url ? { href: p.url, target: '_blank', rel: 'noopener noreferrer' } : {}"
                  >
                    <UBadge color="neutral" variant="outline" size="sm">
                      {{ p.title }}
                    </UBadge>
                  </component>
                </div>
                <div v-if="unreadHits(m).length" class="mt-2 flex flex-wrap items-center gap-1" title="Search hits the reply could draw on">
                  <UIcon name="i-lucide-file-search" class="size-3.5 text-(--ui-text-dimmed)" />
                  <component
                    :is="h.url ? 'a' : 'span'"
                    v-for="h in unreadHits(m)"
                    :key="h.ref"
                    v-bind="h.url ? { href: h.url, target: '_blank', rel: 'noopener noreferrer' } : {}"
                  >
                    <UBadge color="neutral" variant="soft" size="sm" class="text-(--ui-text-muted)">
                      {{ h.title }}
                    </UBadge>
                  </component>
                </div>
              </template>
              <p class="mt-1 text-[11px] opacity-60">
                {{ when(m.created_at) }}
              </p>
            </div>
          </div>
          <p v-if="data!.messages.length === 0" class="text-(--ui-text-muted)">
            No messages.
          </p>
        </section>

        <aside class="space-y-4">
          <UCard>
            <dl class="space-y-3 text-sm">
              <div>
                <dt class="text-(--ui-text-muted)">
                  Widget
                </dt>
                <dd>{{ conversation.widget_name }}</dd>
              </div>
              <div v-if="conversation.page_url">
                <dt class="text-(--ui-text-muted)">
                  Page
                </dt>
                <dd class="break-all">
                  <a v-if="pageHref" :href="pageHref" target="_blank" rel="noopener noreferrer" class="underline">{{ conversation.page_url }}</a>
                  <span v-else>{{ conversation.page_url }}</span>
                </dd>
              </div>
              <div>
                <dt class="text-(--ui-text-muted)">
                  Visitor email
                </dt>
                <dd>{{ conversation.visitor_email || 'Not given' }}</dd>
              </div>
              <div>
                <dt class="text-(--ui-text-muted)">
                  Started
                </dt>
                <dd>{{ when(conversation.created_at) }}</dd>
              </div>
              <div>
                <dt class="text-(--ui-text-muted)">
                  Last message
                </dt>
                <dd>{{ when(conversation.last_message_at) }}</dd>
              </div>
              <div v-if="conversation.ended_at">
                <dt class="text-(--ui-text-muted)">
                  Ended
                </dt>
                <dd>{{ when(conversation.ended_at) }} (the widget's libraries changed)</dd>
              </div>
              <div v-if="conversation.user_agent">
                <dt class="text-(--ui-text-muted)">
                  Browser
                </dt>
                <dd class="text-xs break-words">
                  {{ conversation.user_agent }}
                </dd>
              </div>
            </dl>
          </UCard>

          <UCard v-if="conversation.inbox_conversation_id">
            <p class="text-sm mb-3">
              {{ conversation.handoff_kind === 'staff' ? 'Elevated to the inbox' : 'The visitor asked for help' }}
              {{ when(conversation.handed_off_at) }}.
            </p>
            <UButton
              v-if="status?.inboxAvailable"
              :to="inboxLink(conversation.inbox_conversation_id)"
              icon="i-lucide-inbox"
              block
            >
              Open in inbox
            </UButton>
          </UCard>
        </aside>
      </div>
    </div>
  </HelpinatorShell>
</template>
