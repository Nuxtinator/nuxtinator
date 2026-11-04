<script setup lang="ts">
import type {
  AssistantScopeKind,
  AssistantMessage,
  AssistantConversation,
  AssistantProposal
} from '../../composables/useContextAssistant'
import { useContextAssistantTurn } from '../../composables/useContextAssistantTurn'

const {
  open, scope, conversationId, routeSlug, routeKey, availableScopes, target, targetKey
} = useContextAssistant()
const { turn, inFlight, display, start: startTurn, clear: clearTurn } = useContextAssistantTurn()

const SCOPE_LABELS: Record<AssistantScopeKind, string> = {
  section: 'Section',
  portfolio: 'Portfolio',
  all: 'All portfolios'
}

const conversations = ref<AssistantConversation[]>([])
const messages = ref<AssistantMessage[]>([])
const canApply = ref(false)
const loading = ref(false)
// Creating the conversation precedes the turn; both lock the composer.
const creating = ref(false)
const sending = computed(() => creating.value || inFlight.value)
const decidingKey = ref<string | null>(null)
const error = ref<string | null>(null)
const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

const conversationItems = computed(() =>
  conversations.value.map(c => ({ value: c.id, label: c.title || 'Untitled chat' }))
)

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, statusMessage?: string, message?: string } | null
  return err?.data?.statusMessage || err?.statusMessage || err?.message || 'Something went wrong.'
}

function scrollToBottom() {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  })
}

async function loadConversations() {
  const params = new URLSearchParams()
  if (target.value.portfolio) params.set('portfolio', target.value.portfolio)
  if (target.value.section) params.set('section', target.value.section)
  const url: string = `/api/context/assistant/conversations?${params.toString()}`
  const data = await $fetch<{ conversations: AssistantConversation[] }>(url)
  conversations.value = data.conversations
  if (!conversations.value.some(c => c.id === conversationId.value)) {
    conversationId.value = conversations.value[0]?.id ?? null
  }
}

async function loadMessages() {
  if (!conversationId.value) {
    messages.value = []
    return
  }
  const url: string = `/api/context/assistant/conversations/${conversationId.value}`
  const data = await $fetch<{ messages: AssistantMessage[], can_apply: boolean }>(url)
  messages.value = data.messages
  canApply.value = data.can_apply
  scrollToBottom()
}

async function refreshAll() {
  loading.value = true
  error.value = null
  try {
    await loadConversations()
    await loadMessages()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

watch(targetKey, () => {
  if (open.value) refreshAll()
})
watch(open, (isOpen) => {
  if (isOpen) refreshAll()
})
watch(conversationId, () => {
  if (open.value && !sending.value) loadMessages().catch(e => (error.value = errorMessage(e)))
})

function newChat() {
  conversationId.value = null
  messages.value = []
  error.value = null
}

async function removeChat() {
  if (!conversationId.value) return
  const id = conversationId.value
  try {
    const url: string = `/api/context/assistant/conversations/${id}`
    await $fetch(url, { method: 'DELETE' })
    conversations.value = conversations.value.filter(c => c.id !== id)
    conversationId.value = conversations.value[0]?.id ?? null
    if (!conversationId.value) messages.value = []
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function ensureConversation(): Promise<string> {
  if (conversationId.value) return conversationId.value
  const url: string = '/api/context/assistant/conversations'
  const data = await $fetch<{ conversation: AssistantConversation }>(url, {
    method: 'POST',
    body: {
      ...(target.value.portfolio ? { portfolio: target.value.portfolio } : {}),
      ...(target.value.section ? { section: target.value.section } : {})
    }
  })
  conversations.value = [data.conversation, ...conversations.value]
  conversationId.value = data.conversation.id
  return data.conversation.id
}

async function send(event?: Event) {
  event?.preventDefault?.()
  const text = draft.value.trim()
  if (!text || sending.value) return
  error.value = null
  draft.value = ''
  scrollToBottom()
  creating.value = true
  const id = await ensureConversation()
    .catch((e) => {
      error.value = errorMessage(e)
      draft.value = text
      return null
    })
    .finally(() => {
      creating.value = false
    })
  if (!id) return
  // Settles when the turn does; the watchers below apply the outcome, so the
  // panel need not stay mounted for the duration.
  await startTurn(id, text)
}

function titleFor(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

// The turn rendered inline: the one running for the open conversation.
const activeTurn = computed(() =>
  turn.value && inFlight.value && turn.value.conversationId === conversationId.value ? turn.value : null
)

watch(() => turn.value?.result, (result) => {
  if (!result || !turn.value) return
  if (turn.value.conversationId === conversationId.value) {
    // The list may already hold the turn if it was reloaded while it ran.
    for (const m of [result.user_message, result.assistant_message]) {
      if (!messages.value.some(x => x.id === m.id)) messages.value.push(m)
    }
    canApply.value = result.can_apply
    const conv = conversations.value.find(c => c.id === conversationId.value)
    if (conv && !conv.title) conv.title = titleFor(turn.value.userText)
    scrollToBottom()
  }
  clearTurn()
}, { immediate: true })

watch(() => turn.value?.error, (err) => {
  if (!err || !turn.value) return
  error.value = err
  // A dropped connection is not a failed turn — the server finishes it — so
  // the text is offered for resending only when the turn actually failed.
  if (!turn.value.lost && !draft.value) draft.value = turn.value.userText
  clearTurn()
}, { immediate: true })

watch(() => turn.value?.text.length, () => scrollToBottom())

async function decide(message: AssistantMessage, index: number, action: 'apply' | 'reject') {
  const key = `${message.id}:${index}`
  decidingKey.value = key
  error.value = null
  try {
    const url: string = `/api/context/assistant/conversations/${message.conversation_id}/proposals`
    const data = await $fetch<{ proposal: AssistantProposal }>(url, {
      method: 'POST',
      body: { message_id: message.id, index, action }
    })
    message.proposals.splice(index, 1, data.proposal)
    if (action === 'apply') {
      const p = data.proposal
      await refreshNuxtData([
        `context-section-${p.portfolio_slug}-${p.section_key}`,
        `context-sections-${p.portfolio_slug}`,
        `context-sidebar-sections-${p.portfolio_slug}`
      ])
    }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    decidingKey.value = null
  }
}

const emptyHint = computed(() => {
  if (scope.value === 'section') return `Focused on the "${routeKey.value}" section of ${routeSlug.value}.`
  if (scope.value === 'portfolio') return `Using the full "${routeSlug.value}" portfolio.`
  return 'Using every portfolio in this workspace.'
})
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="Assistant"
    :ui="{ content: 'w-full sm:max-w-xl', body: 'p-0 flex flex-col' }"
  >
    <template #description>
      <div class="flex flex-wrap items-center gap-2 mt-2">
        <UFieldGroup size="xs">
          <UButton
            v-for="kind in availableScopes"
            :key="kind"
            :variant="scope === kind ? 'solid' : 'outline'"
            :color="scope === kind ? 'primary' : 'neutral'"
            @click="scope = kind"
          >
            {{ SCOPE_LABELS[kind] }}
          </UButton>
        </UFieldGroup>
        <span class="flex-1" />
        <USelectMenu
          v-if="conversations.length"
          :model-value="conversationId ?? undefined"
          :items="conversationItems"
          value-key="value"
          label-key="label"
          :search-input="false"
          placeholder="New chat"
          size="xs"
          class="w-44"
          @update:model-value="(v: string) => (conversationId = v)"
        />
        <UButton
          icon="i-lucide-plus"
          size="xs"
          variant="ghost"
          color="neutral"
          aria-label="New chat"
          title="New chat"
          :disabled="!conversationId"
          @click="newChat"
        />
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          variant="ghost"
          color="neutral"
          aria-label="Delete chat"
          title="Delete chat"
          :disabled="!conversationId"
          @click="removeChat"
        />
      </div>
    </template>

    <template #body>
      <div ref="listEl" class="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div v-if="loading" class="text-sm text-(--ui-text-muted)">
          Loading…
        </div>
        <div v-else-if="messages.length === 0 && !sending" class="h-full flex items-center justify-center text-center">
          <div class="text-sm text-(--ui-text-muted)">
            <UIcon name="i-lucide-sparkles" class="size-6 mb-2" />
            <p>Ask a question or tell me what to update.</p>
            <p class="text-xs text-(--ui-text-dimmed) mt-1">
              {{ emptyHint }}
            </p>
          </div>
        </div>

        <div v-for="m in messages" :key="m.id">
          <div
            v-if="m.role === 'assistant' && m.context_loaded.length"
            class="mb-2 inline-flex items-center gap-1.5 text-xs text-(--ui-text-dimmed) bg-(--ui-bg-elevated) border border-(--ui-border) rounded px-2 py-1"
          >
            <UIcon name="i-lucide-book-open" class="size-3" />
            Read {{ m.context_loaded.join(', ') }}
          </div>

          <div class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
            <div
              class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm"
              :class="m.role === 'user'
                ? 'bg-(--ui-primary) text-(--ui-bg) rounded-tr-sm whitespace-pre-wrap'
                : 'bg-(--ui-bg-elevated) border border-(--ui-border) rounded-tl-sm'"
            >
              <ContextAssistantMarkdown v-if="m.role === 'assistant'" :content="m.content" />
              <template v-else>
                {{ m.content }}
              </template>
            </div>
          </div>

          <div v-if="m.role === 'assistant' && m.proposals.length" class="mt-3 space-y-2 max-w-[85%]">
            <ContextAssistantProposalCard
              v-for="(p, i) in m.proposals"
              :key="`${m.id}:${i}`"
              :proposal="p"
              :index="i"
              :total="m.proposals.length"
              :can-apply="canApply"
              :busy="decidingKey === `${m.id}:${i}`"
              :show-portfolio="scope === 'all'"
              @decide="(action) => decide(m, i, action)"
            />
          </div>
        </div>

        <template v-if="activeTurn">
          <div class="flex justify-end">
            <div class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-(--ui-primary) text-(--ui-bg) rounded-tr-sm whitespace-pre-wrap">
              {{ activeTurn.userText }}
            </div>
          </div>
          <div class="flex justify-start">
            <div class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm bg-(--ui-bg-elevated) border border-(--ui-border) rounded-tl-sm">
              <UChatShimmer v-if="!display || (!display.visible && display.drafting.length === 0)" :text="activeTurn.status" />
              <template v-else>
                <ContextAssistantMarkdown v-if="display.visible" :content="display.visible" />
                <div
                  v-for="(title, i) in display.drafting"
                  :key="i"
                  class="mt-2 flex items-center gap-1.5 text-xs text-(--ui-text-dimmed)"
                >
                  <UIcon name="i-lucide-pen-line" class="size-3 animate-pulse" />
                  {{ title ? `Drafting an update to ${title}…` : 'Drafting an update…' }}
                </div>
              </template>
            </div>
          </div>
        </template>
        <div v-else-if="sending" class="flex justify-start">
          <div class="bg-(--ui-bg-elevated) border border-(--ui-border) rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm">
            <UChatShimmer text="Thinking…" />
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="w-full space-y-2">
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :description="error"
          :close="true"
          @update:open="error = null"
        />
        <UChatPrompt
          v-model="draft"
          placeholder="Ask anything or paste meeting notes…"
          :rows="2"
          :maxrows="8"
          :disabled="sending"
          @submit="send"
        >
          <UChatPromptSubmit :status="sending ? 'submitted' : 'ready'" :disabled="!draft.trim() || sending" />
        </UChatPrompt>
      </div>
    </template>
  </USlideover>
</template>
