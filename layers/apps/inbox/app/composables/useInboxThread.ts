// Detail-pane state for one conversation: the thread payload plus the triage
// and reply actions. Fetches re-run on org switches (org-keyed watch), and
// stale responses are dropped.

import type { MaybeRefOrGetter } from 'vue'

// Reviewer-only metadata on an AI-generated draft (never emailed). Mirrors the
// server's InboxAiDraftMetadata; declared here so client code doesn't reach into
// server/.
export interface InboxAiMetadata {
  gloss: string
  language: string
  sources: string[]
  uncertainty: string[]
  model: string
}

export interface InboxThreadMessage {
  id: string
  direction: 'inbound' | 'outbound'
  status: string
  senderName: string | null
  fromEmail: string | null
  fromName: string | null
  toEmail: string | null
  subject: string | null
  bodyHtml: string | null
  bodyStrippedHtml: string | null
  bodyText: string | null
  authenticated: boolean
  holdReason: string | null
  failedReason: string | null
  deliveredAt: string | null
  createdAt: string
  aiGenerated: boolean
  attachments: { id: string, filename: string | null, contentType: string | null, sizeBytes: number | null }[]
}

export interface InboxThreadDraft {
  id: string
  senderName: string | null
  fromEmail: string | null
  subject: string | null
  bodyHtml: string | null
  bodyText: string | null
  createdAt: string
  aiGenerated: boolean
  aiMetadata: InboxAiMetadata | null
  attachments: { id: string, filename: string | null, contentType: string | null, sizeBytes: number | null }[]
}

// A generated (unpersisted) draft preview returned by the AI generate call.
export interface InboxAiDraftPreview {
  draft_language: string
  draft_html: string
  draft_text: string
  english_gloss: string
  sources_used: string[]
  uncertainty: string[]
}

// Deliverability of the address a reply goes to — resolved server-side by the
// same util the send sweep uses, so the composer shows exactly where mail
// will go and why it might not get there.
export interface InboxReplyStatus {
  email: string | null
  verified: boolean
  suppression: { reason: string, detail: string | null, since: string } | null
}

export interface InboxThread {
  conversation: {
    id: string
    subject: string | null
    status: string
    assignedUserId: string | null
    needsReview: boolean
    source: string
    counterpartyName: string | null
    tags: string[]
    lastMessageAt: string | null
    createdAt: string
  }
  channel: { value: string, verified: boolean, blocked: boolean } | null
  contacts: { id: string, name: string }[]
  replyStatus: InboxReplyStatus
  capabilities: { canSend: boolean, canCreateContact: boolean }
  messages: InboxThreadMessage[]
  drafts: InboxThreadDraft[]
}

// An outbound message is delivered asynchronously by the send sweep, so a
// freshly-queued reply is still `queued` when the reply POST returns. Poll the
// thread while any outbound message sits in `queued`, so the UI reflects the
// queued→sent/delivered/failed transition without a manual refresh. A healthy
// send resolves within one sweep tick (seconds), but a provider failure backs
// off 2 then 4 minutes before going terminal — so poll fast at first, then
// slowly for the rest of the retry lifecycle. The overall window outlives the
// worst-case retry chain; only a genuinely wedged queue (sweep disabled) is
// left un-polled after that.
const THREAD_POLL_FAST_MS = 2500
const THREAD_POLL_SLOW_MS = 15_000
const THREAD_POLL_FAST_WINDOW_MS = 60_000
const THREAD_POLL_WINDOW_MS = 600_000

function threadHasPendingOutbound(t: InboxThread | null): boolean {
  return !!t?.messages.some(m => m.direction === 'outbound' && m.status === 'queued')
}

export function useInboxThread(conversationId: MaybeRefOrGetter<string | null>) {
  const orgKey = useCrmOrgKey()
  const thread = ref<InboxThread | null>(null)
  const pending = ref(false)
  const error = ref<string | null>(null)

  let requestId = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollUntil = 0

  function stopPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  // Re-arm the poll after each fetch: keep chasing while an outbound message is
  // still `queued` and the poll window is open; give up (and reset) once it
  // settles or the window elapses. Fast cadence for the first stretch (the
  // healthy-send path), slow cadence for the remainder (the retry-backoff path).
  function schedulePoll(): void {
    stopPoll()
    if (!threadHasPendingOutbound(thread.value)) {
      pollUntil = 0
      return
    }
    if (pollUntil === 0) pollUntil = Date.now() + THREAD_POLL_WINDOW_MS
    if (Date.now() > pollUntil) return
    const pollStartedAt = pollUntil - THREAD_POLL_WINDOW_MS
    const interval = Date.now() - pollStartedAt < THREAD_POLL_FAST_WINDOW_MS
      ? THREAD_POLL_FAST_MS
      : THREAD_POLL_SLOW_MS
    pollTimer = setTimeout(() => { void refresh({ poll: true }) }, interval)
  }

  async function refresh(opts?: { poll?: boolean }): Promise<void> {
    const id = toValue(conversationId)
    if (!id) {
      stopPoll()
      thread.value = null
      return
    }
    const rid = ++requestId
    // A background poll must not flip the pane into a loading state.
    if (!opts?.poll) pending.value = true
    try {
      const res = await $fetch<InboxThread>(`/api/inbox/conversations/${id}`)
      if (rid !== requestId) return
      thread.value = res
      error.value = null
      schedulePoll()
    } catch (err) {
      if (rid !== requestId) return
      thread.value = null
      error.value = err instanceof Error ? err.message : 'Failed to load conversation'
      stopPoll()
    } finally {
      if (rid === requestId && !opts?.poll) pending.value = false
    }
  }

  watch([() => toValue(conversationId), orgKey], () => {
    pollUntil = 0
    stopPoll()
    refresh()
  }, { immediate: true })

  onScopeDispose(stopPoll)

  async function patch(body: { status?: string, assignedUserId?: string | null, needsReview?: boolean }) {
    const id = toValue(conversationId)
    if (!id) return
    // Widened to string: a template-literal URL narrows to the typed GET
    // route, which rejects other methods.
    const url: string = `/api/inbox/conversations/${id}`
    await $fetch(url, { method: 'PATCH', body })
    await refresh()
  }

  // Send: a fresh queued reply, or (with draftId) promote that draft. The From
  // identity (personal alias vs shared contact address) rides the send.
  async function reply(body: string, draftId?: string, fromIdentity?: 'personal' | 'contact') {
    const id = toValue(conversationId)
    if (!id) return
    await $fetch(`/api/inbox/conversations/${id}/messages`, {
      method: 'POST',
      body: { body, ...(draftId ? { draftId } : {}), ...(fromIdentity ? { fromIdentity } : {}) }
    })
    await refresh()
  }

  // Create (no draftId) or update a shared draft; returns its id so the caller
  // can keep editing the same draft. `fromIdentity` travels with the draft
  // (absent = keep the stored choice).
  async function saveDraft(body: string, draftId?: string, fromIdentity?: 'personal' | 'contact'): Promise<string | undefined> {
    const id = toValue(conversationId)
    if (!id) return
    const res = await $fetch<{ id: string }>(`/api/inbox/conversations/${id}/messages`, {
      method: 'POST',
      body: { saveDraft: true, body, ...(draftId ? { draftId } : {}), ...(fromIdentity ? { fromIdentity } : {}) }
    })
    await refresh()
    return res.id
  }

  async function deleteDraft(draftId: string) {
    const id = toValue(conversationId)
    if (!id) return
    const url: string = `/api/inbox/conversations/${id}/drafts/${draftId}`
    await $fetch(url, { method: 'DELETE' })
    await refresh()
  }

  // Generate an AI draft preview (no persistence). `baseDraft` + `direction`
  // drive the steer/refine loop.
  async function generateAiDraft(input: { direction?: string, baseDraft?: string } = {}): Promise<InboxAiDraftPreview> {
    const id = toValue(conversationId)
    if (!id) throw new Error('No conversation selected')
    const url: string = `/api/inbox/conversations/${id}/draft-reply`
    return await $fetch<InboxAiDraftPreview>(url, {
      method: 'POST',
      body: { direction: input.direction, baseDraft: input.baseDraft }
    })
  }

  // Persist the reviewer's chosen AI draft verbatim as a shared ai_generated
  // draft; returns its id (reused on regenerate via draftId). Refreshes so the
  // draft appears in the thread.
  async function saveAiDraft(input: {
    html: string
    text?: string
    meta: InboxAiMetadata
    draftId?: string
    fromIdentity?: 'personal' | 'contact'
  }): Promise<string | undefined> {
    const id = toValue(conversationId)
    if (!id) return
    const url: string = `/api/inbox/conversations/${id}/draft-reply`
    const res = await $fetch<{ id: string }>(url, {
      method: 'POST',
      body: {
        draftId: input.draftId,
        fromIdentity: input.fromIdentity,
        save: {
          html: input.html,
          text: input.text,
          language: input.meta.language,
          gloss: input.meta.gloss,
          sources: input.meta.sources,
          uncertainty: input.meta.uncertainty
        }
      }
    })
    await refresh()
    return res.id
  }

  // Attachments bind to a draft. The caller ensures a draft exists first.
  async function uploadAttachment(draftId: string, file: File): Promise<void> {
    const id = toValue(conversationId)
    if (!id) return
    const form = new FormData()
    form.append('draftId', draftId)
    form.append('file', file)
    const url: string = `/api/inbox/conversations/${id}/attachments`
    await $fetch(url, { method: 'POST', body: form })
    await refresh()
  }

  async function removeAttachment(attachmentId: string): Promise<void> {
    const id = toValue(conversationId)
    if (!id) return
    const url: string = `/api/inbox/conversations/${id}/attachments/${attachmentId}`
    await $fetch(url, { method: 'DELETE' })
    await refresh()
  }

  // Inline images upload immediately (org-scoped, no conversation needed) and
  // return the auth-proxy URL the editor embeds; the CID pipeline turns it
  // into an inline part at send time.
  async function uploadInlineImage(file: File): Promise<string> {
    const form = new FormData()
    form.append('image', file)
    const res = await $fetch<{ url: string }>('/api/inbox/inline-images', { method: 'POST', body: form })
    return res.url
  }

  async function createContact(name: string) {
    const id = toValue(conversationId)
    if (!id) return
    const record = await $fetch<{ id: string }>(`/api/inbox/conversations/${id}/contact`, {
      method: 'POST',
      body: { name }
    })
    await refresh()
    return record
  }

  return { thread, pending, error, refresh, patch, reply, saveDraft, deleteDraft, generateAiDraft, saveAiDraft, uploadAttachment, removeAttachment, uploadInlineImage, createContact }
}

export interface InboxAssignee {
  id: string
  displayName: string
  avatar: string | null
}

export function useInboxAssignees() {
  const orgKey = useCrmOrgKey()
  const users = ref<InboxAssignee[]>([])
  async function refresh() {
    try {
      const res = await $fetch<{ users: InboxAssignee[] }>('/api/inbox/assignees')
      users.value = res.users
    } catch {
      users.value = []
    }
  }
  watch(orgKey, () => refresh(), { immediate: true })
  return { users, refresh }
}
