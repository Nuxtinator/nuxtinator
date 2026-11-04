<script setup lang="ts">
// One suggestion set: every section it touches as a diff, with approve /
// reject for reviewers and withdraw for the author.
import type { SuggestionItem } from '../../../utils/suggestion-status'

definePageMeta({ middleware: 'auth' })

interface SetDetail {
  id: string
  portfolio_slug: string
  portfolio_name: string
  author_name: string | null
  note: string | null
  created_at: string
  suggestions: SuggestionItem[]
}

interface SetResponse {
  set: SetDetail
  can_review: boolean
  is_author: boolean
}

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const sidebarOpen = ref(false)

// Where to go once the set is fully decided, when the review was opened from a section.
const returnTo = computed(() => {
  const r = route.query.return
  return typeof r === 'string' && r.startsWith('/context/') ? r : null
})

const { data, error: loadError } = await useAsyncData(
  () => `context-suggestion-${id.value}`,
  () => $fetch<SetResponse>(`/api/context/suggestions/${id.value}`)
)
const set = computed(() => data.value?.set ?? null)

const { refresh: refreshNotifications } = useNotifications()
watch(() => set.value?.id, (setId) => {
  if (!setId) return
  $fetch(`/api/context/suggestions/${setId}/read`, { method: 'POST' })
    .then(() => refreshNotifications())
    .catch(() => {})
}, { immediate: true })

const pendingItems = computed(() => set.value?.suggestions.filter(s => s.status === 'pending') ?? [])

// The open review queue, for stepping between sets and moving on once this
// one has nothing left pending.
const { data: queueData, refresh: refreshQueue } = await useAsyncData(
  'context-suggestions-queue',
  () => $fetch<{ sets: Array<{ id: string }> }>('/api/context/suggestions', { query: { state: 'open' } })
)
const queueIds = computed(() => queueData.value?.sets.map(s => s.id) ?? [])
const queueIndex = computed(() => queueIds.value.indexOf(id.value))
const prevId = computed(() => queueIndex.value > 0 ? queueIds.value[queueIndex.value - 1] : undefined)
const nextId = computed(() => queueIndex.value >= 0 ? queueIds.value[queueIndex.value + 1] : undefined)

async function advance() {
  if (returnTo.value) return navigateTo(returnTo.value)
  const target = nextId.value ?? queueIds.value.find(q => q !== id.value)
  await refreshQueue()
  await navigateTo(target ? `/context/suggestions/${target}` : '/context/suggestions')
}
const approvable = computed(() => pendingItems.value.filter(s => s.section_exists))

type Action = 'approve' | 'reject' | 'withdraw'
const busy = ref(false)
const error = ref<string | null>(null)

// Reject always asks (for an optional note); approve asks only when it would
// overwrite changes made since the suggestion; withdraw asks when it covers
// more than one section.
const confirm = ref<{ action: Action, ids?: string[], content?: string } | null>(null)
const confirmOpen = computed({
  get: () => confirm.value !== null,
  set: (v) => { if (!v) confirm.value = null }
})
const rejectNote = ref('')

function targets(ids?: string[]): SuggestionItem[] {
  return ids ? pendingItems.value.filter(s => ids.includes(s.id)) : pendingItems.value
}

function request(action: Action, ids?: string[], content?: string) {
  const items = targets(ids)
  const needsConfirm = action === 'reject'
    || (action === 'approve' && items.some(s => s.stale))
    || (action === 'withdraw' && items.length > 1)
  if (needsConfirm) {
    rejectNote.value = ''
    confirm.value = { action, ids, content }
  } else {
    void run(action, ids, content)
  }
}

async function run(action: Action, ids?: string[], content?: string) {
  busy.value = true
  error.value = null
  try {
    const url = action === 'withdraw'
      ? `/api/context/suggestions/${id.value}/withdraw`
      : `/api/context/suggestions/${id.value}/decide`
    const body = action === 'withdraw'
      ? { ...(ids ? { suggestion_ids: ids } : {}) }
      : {
          action,
          ...(ids ? { suggestion_ids: ids } : {}),
          ...(action === 'reject' && rejectNote.value.trim() ? { note: rejectNote.value.trim() } : {}),
          ...(action === 'approve' && content !== undefined ? { content } : {})
        }
    const res = await $fetch<{ set: SetDetail }>(url, { method: 'POST', body })
    if (data.value) data.value = { ...data.value, set: res.set }
    confirm.value = null
    await refreshNuxtData([
      'context-suggestions-pending-count',
      `context-sidebar-sections-${res.set.portfolio_slug}`
    ])
    if (!res.set.suggestions.some(s => s.status === 'pending')) await advance()
  } catch (e) {
    error.value = (e as { statusMessage?: string }).statusMessage ?? 'Something went wrong.'
  } finally {
    busy.value = false
  }
}

const confirmCopy = computed(() => {
  const c = confirm.value
  if (!c) return { title: '', description: '', label: '', color: 'primary' as const }
  const n = targets(c.ids).length
  const what = n === 1 ? 'this suggestion' : `${n} suggestions`
  if (c.action === 'reject') {
    return { title: `Reject ${what}?`, description: '', label: 'Reject', color: 'error' as const }
  }
  if (c.action === 'withdraw') {
    return { title: `Withdraw ${what}?`, description: 'They leave the review queue and nothing is changed.', label: 'Withdraw', color: 'error' as const }
  }
  return {
    title: `Approve ${what}?`,
    description: 'At least one section changed after it was suggested. Approving replaces the current content, including those changes. Earlier content stays in version history.',
    label: 'Approve',
    color: 'primary' as const
  }
})
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
        <UButton variant="ghost" icon="i-lucide-arrow-left" size="sm" :to="returnTo ?? '/context/suggestions'" aria-label="Back" />
        <div class="flex-1 min-w-0">
          <h1 class="font-semibold truncate">
            {{ set ? `Suggested changes to ${set.portfolio_name}` : 'Suggestion' }}
          </h1>
          <p v-if="set" class="text-xs text-(--ui-text-muted) truncate">
            {{ set.author_name ?? 'Unknown' }} · {{ new Date(set.created_at).toLocaleString() }}
          </p>
        </div>
        <div v-if="queueIndex >= 0 && queueIds.length > 1" class="flex items-center gap-1">
          <UButton
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-left"
            size="sm"
            aria-label="Previous suggestion"
            :disabled="!prevId"
            :to="prevId ? `/context/suggestions/${prevId}` : undefined"
          />
          <span class="text-xs text-(--ui-text-muted) tabular-nums">
            {{ queueIndex + 1 }} / {{ queueIds.length }}
          </span>
          <UButton
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-right"
            size="sm"
            aria-label="Next suggestion"
            :disabled="!nextId"
            :to="nextId ? `/context/suggestions/${nextId}` : undefined"
          />
        </div>
        <template v-if="set && pendingItems.length > 1">
          <template v-if="data?.can_review">
            <UButton
              size="sm"
              color="success"
              icon="i-lucide-check-check"
              :disabled="busy || approvable.length === 0"
              @click="request('approve', approvable.map(s => s.id))"
            >
              Approve all
            </UButton>
            <UButton size="sm" color="error" variant="soft" :disabled="busy" @click="request('reject')">
              Reject all
            </UButton>
          </template>
          <UButton
            v-if="data?.is_author"
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-undo-2"
            :disabled="busy"
            @click="request('withdraw')"
          >
            Withdraw all
          </UButton>
        </template>
      </header>

      <div class="flex-1 overflow-auto p-6">
        <div class="max-w-4xl mx-auto space-y-4">
          <p v-if="loadError" class="text-sm text-(--ui-text-muted)">
            This suggestion doesn't exist or you can't see it.
          </p>
          <template v-else-if="set">
            <div v-if="set.note" class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-3 text-sm whitespace-pre-wrap">
              {{ set.note }}
            </div>
            <p v-if="error" class="text-sm text-(--ui-error)">
              {{ error }}
            </p>
            <ContextSuggestionCard
              v-for="s in set.suggestions"
              :key="s.id"
              :suggestion="s"
              :portfolio-slug="set.portfolio_slug"
              :can-review="!!data?.can_review"
              :is-author="!!data?.is_author"
              :busy="busy"
              @approve="(content?: string) => request('approve', [s.id], content)"
              @reject="request('reject', [s.id])"
              @withdraw="request('withdraw', [s.id])"
            />
          </template>
        </div>
      </div>
    </section>

    <ContextConfirmModal
      v-model:open="confirmOpen"
      :title="confirmCopy.title"
      :confirm-label="confirmCopy.label"
      :color="confirmCopy.color"
      :loading="busy"
      @confirm="confirm && run(confirm.action, confirm.ids, confirm.content)"
    >
      <div v-if="confirm?.action === 'reject'" class="space-y-2">
        <p class="text-sm text-(--ui-text-muted)">
          The suggester sees this note when they check their suggestions.
        </p>
        <UTextarea v-model="rejectNote" placeholder="Reason (optional)" :rows="3" autoresize class="w-full" />
      </div>
      <p v-else class="text-sm text-(--ui-text-muted)">
        {{ confirmCopy.description }}
      </p>
    </ContextConfirmModal>
  </div>
</template>
