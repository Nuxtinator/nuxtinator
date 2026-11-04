<script setup lang="ts">
// The detail pane: triage header (contact chips, assignee, status, review
// flag), the message thread, and the reply composer. Destructive status
// transitions (spam) confirm first — marking spam blocklists the sender and
// closes all their threads.
import type { InboxThread, InboxThreadDraft, InboxAiMetadata } from '../../composables/useInboxThread'
import type { InboxAssignee } from '../../composables/useInboxThread'
import type { InboxTag, InboxTagColor } from '../../composables/useInboxTags'
import type { InboxCannedResponse } from '../../composables/useInboxCanned'
import type { InboxMe } from '../../composables/useInboxMe'
import type { DropdownMenuItem } from '@nuxt/ui'

const props = defineProps<{
  thread: InboxThread
  assignees: InboxAssignee[]
  palette: InboxTag[]
  canned: InboxCannedResponse[]
  me: InboxMe | null
  sending?: boolean
  uploadInlineImage?: (file: File) => Promise<string>
  // Whether AI drafting is available (configured + a model enabled for the org).
  aiAvailable?: boolean
  // Reviewer-only AI pack for the loaded draft — shown above the composer, never
  // emailed.
  aiMeta?: InboxAiMetadata | null
}>()

const emit = defineEmits<{
  patch: [body: { status?: string, assignedUserId?: string | null, needsReview?: boolean }]
  reply: [body: string, draftId?: string, fromIdentity?: 'personal' | 'contact']
  saveDraft: [body: string, fromIdentity?: 'personal' | 'contact']
  deleteDraft: [draftId: string]
  attachFiles: [files: File[], body: string]
  removeAttachment: [attachmentId: string]
  createContact: [name: string]
  setTags: [slugs: string[]]
  createTag: [name: string, color: InboxTagColor]
  deleteTag: [slug: string]
  aiDraft: []
  addKnowledge: []
  dismissAiMeta: []
  loadDraftMeta: [meta: InboxAiMetadata | null]
}>()

// The draft the composer is currently editing (null = a fresh reply). Owned by
// the parent so its save handler can write back the new id after creating one.
const currentDraftId = defineModel<string | null>('draftId', { default: null })

const crmPath = useCrmPath()

// Composer body — parent-owned (v-model:reply-body) so an AI draft can be pushed
// in from the AI modal and land in the editor.
const replyBody = defineModel<string>('replyBody', { default: '' })
const confirmSpam = ref(false)
const confirmClose = ref(false)

// Whether the conversation is resolved enough to capture a knowledge entry
// from — and whether this user may (KB writes are inbox.send-tier, same as
// the server gate on POST /knowledge-entries).
const canAddKnowledge = computed(() =>
  props.aiAvailable && props.thread.capabilities.canSend && ['pending', 'closed'].includes(props.thread.conversation.status)
)
// Gloss is shown only when the draft isn't English (an English reviewer aid).
const showAiGloss = computed(() =>
  !!props.aiMeta?.gloss && !props.aiMeta.language.toLowerCase().startsWith('en')
)
const contactName = ref('')
const showCreateContact = ref(false)
// Detail-pane view: the email thread, or the internal notes & activity feed.
const view = ref<'conversation' | 'notes'>('conversation')

// From identity selection — offered only when the agent has a personal alias.
// The shared option is labelled with the brand From name actually sent.
const fromOptions = computed(() => {
  const opts: { label: string, value: 'personal' | 'contact' }[] = []
  if (props.me?.personalFrom) opts.push({ label: `You · ${props.me.personalFrom}`, value: 'personal' })
  opts.push({ label: `${props.me?.brandFromName || 'Shared'} · ${props.me?.contactAddress ?? 'contact address'}`, value: 'contact' })
  return opts
})
// Continuity heuristic: default to the shared address, unless a prior non-draft
// outbound in this thread already went out on a personal address.
const defaultFromIdentity = computed<'personal' | 'contact'>(() => {
  const contact = props.me?.contactAddress?.toLowerCase()
  const priorPersonal = props.thread.messages.some(m =>
    m.direction === 'outbound' && m.status !== 'draft' && m.fromEmail && contact && m.fromEmail.toLowerCase() !== contact
  )
  return priorPersonal && props.me?.personalFrom ? 'personal' : 'contact'
})
const fromIdentity = ref<'personal' | 'contact'>('contact')
const signatureNotice = computed(() => {
  if (fromIdentity.value !== 'personal') return 'no signature'
  return props.me?.signature ? 'your signature is added' : 'no signature set'
})
// The signature is appended server-side at queue time, so it never appears in
// the editor — the preview is the only way to see what will actually go out.
const showSignaturePreview = ref(false)

// Every send needs the org's shared contact address for its From identity;
// without one the sweep holds the message instead of delivering it. Send is
// blocked here so nobody writes a reply believing it went out. Drafting and
// saving stay open — the text is preserved either way.
const hasSendAddress = computed(() => !!props.me?.contactAddress)

// Deliverability of the reply target: badges in the header and on the
// composer's To line, and the reason a send is blocked. The sweep fails any
// reply to a suppressed address, so Send is disabled rather than queueing a
// message that can only end up 'failed'.
const replyStatus = computed(() => props.thread.replyStatus)
const suppressionMeta = computed(() => {
  const s = replyStatus.value.suppression
  if (!s) return null
  const meta = INBOX_SUPPRESSION_REASON_META[s.reason] ?? { label: s.reason, color: 'neutral' as const }
  return { ...meta, detail: s.detail, since: new Date(s.since).toLocaleDateString() }
})
const canDeliver = computed(() => !!replyStatus.value.email && !replyStatus.value.suppression)

function openConversation() {
  replyBody.value = ''
  currentDraftId.value = null
  showCreateContact.value = false
  fromIdentity.value = defaultFromIdentity.value
  showSignaturePreview.value = false
  view.value = 'conversation'
  emit('dismissAiMeta')
  // Resume where the team left off: the freshest shared draft loads into the
  // composer on open (drafts arrive oldest-first).
  const latest = props.thread.drafts[props.thread.drafts.length - 1]
  if (latest) loadDraft(latest)
}
watch(() => props.thread.conversation.id, openConversation)
// UEditor builds its editor on mount from the body it had at setup and ignores
// body changes before then, so the first draft loads once it exists.
onMounted(openConversation)

function draftPreview(d: InboxThreadDraft): string {
  const text = (d.bodyText || d.bodyHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? (text.length > 28 ? text.slice(0, 28) + '…' : text) : 'Empty draft'
}

function loadDraft(d: InboxThreadDraft) {
  replyBody.value = d.bodyHtml || ''
  currentDraftId.value = d.id
  // Restore the draft's saved From choice ('personal' resolves to the sending
  // agent's own alias at queue time; without one it falls back to shared).
  fromIdentity.value = d.fromEmail && props.me?.personalFrom ? 'personal' : 'contact'
  // Re-surface the AI review panel when reopening an AI draft (null clears it).
  emit('loadDraftMeta', d.aiMetadata)
}

function onSaveDraft() {
  if (props.sending) return
  emit('saveDraft', replyBody.value, props.me?.personalFrom ? fromIdentity.value : undefined)
}

function onDeleteDraft(d: InboxThreadDraft) {
  emit('deleteDraft', d.id)
  if (currentDraftId.value === d.id) {
    replyBody.value = ''
    currentDraftId.value = null
  }
}

const currentDraft = computed(() => props.thread.drafts.find(d => d.id === currentDraftId.value) ?? null)
// The draft being edited is already in the composer, so the picker only shows
// when there is another draft to switch to.
const showDraftChips = computed(() => props.thread.drafts.some(d => d.id !== currentDraftId.value))

// Attachments belong to the draft being edited; the parent creates a draft
// first if there isn't one yet, so files always have a row to bind to.
const currentDraftAttachments = computed(() =>
  currentDraftId.value
    ? props.thread.drafts.find(d => d.id === currentDraftId.value)?.attachments ?? []
    : []
)

const fileInput = ref<HTMLInputElement | null>(null)
function pickFiles() {
  fileInput.value?.click()
}
function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // let the same file be re-selected
  if (files.length) emit('attachFiles', files, replyBody.value)
}

// Inline images: upload to the private bucket, then insert the proxy URL into
// the editor as an <img> (the CID pipeline embeds it at send time).
const replyEditor = ref<{ editor?: { chain: () => { focus: () => { setImage: (o: { src: string }) => { run: () => void } } } } } | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const insertingImage = ref(false)

// `?reply=1` (e.g. a help-chat elevation) lands with the composer focused,
// ready to write.
const route = useRoute()
watch(() => replyEditor.value?.editor, (ed) => {
  if (!ed || route.query.reply !== '1') return
  (ed as unknown as { commands: { focus: (pos?: string) => void } }).commands.focus('end')
}, { immediate: true })
function pickImage() {
  imageInput.value?.click()
}
async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.uploadInlineImage) return
  insertingImage.value = true
  try {
    const url = await props.uploadInlineImage(file)
    replyEditor.value?.editor?.chain().focus().setImage({ src: url }).run()
  } catch (err) {
    useToast().add({ title: 'Image upload failed', description: inboxErrorMessage(err), color: 'error' })
  } finally {
    insertingImage.value = false
  }
}

// Canned responses append into the composer (never replace). Insert through
// the editor so the HTML renders as markup; a leading <br> separates it from
// existing content. Falls back to the v-model string if the editor handle
// isn't mounted yet.
function insertCanned(bodyHtml: string) {
  const ed = replyEditor.value?.editor as unknown as { isEmpty?: boolean, chain: () => { focus: (pos?: string) => { insertContent: (c: string) => { run: () => void } } } } | undefined
  if (!ed) {
    replyBody.value = replyBody.value ? `${replyBody.value}<br>${bodyHtml}` : bodyHtml
    return
  }
  const prefix = ed.isEmpty ? '' : '<br>'
  ed.chain().focus('end').insertContent(prefix + bodyHtml).run()
}

// reka-ui selects reject '' as an item value — the unassigned sentinel is a
// real string swapped back to null on change.
const UNASSIGNED = '__none__'
const assigneeItems = computed(() => [
  { label: 'Unassigned', value: UNASSIGNED },
  ...props.assignees.map(a => ({ label: a.displayName, value: a.id }))
])
const assigneeValue = computed({
  get: () => props.thread.conversation.assignedUserId ?? UNASSIGNED,
  set: (v: string) => emit('patch', { assignedUserId: v === UNASSIGNED ? null : v })
})

const statusItems = [
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'Closed', value: 'closed' },
  { label: 'Spam', value: 'spam' }
]
const statusValue = computed({
  get: () => props.thread.conversation.status,
  set: (v: string) => {
    if (v === 'spam') {
      confirmSpam.value = true
      return
    }
    // Closing also clears the review flag server-side — worth a confirm.
    if (v === 'closed') {
      confirmClose.value = true
      return
    }
    emit('patch', { status: v })
  }
})

// The composer is NOT cleared here — the parent owns replyBody/currentDraftId
// (v-model) and clears them only after the send request succeeds, so a failed
// send keeps the typed text for retry.
function submitReply() {
  if (props.sending || !hasSendAddress.value || !canDeliver.value) return
  const body = replyBody.value.trim()
  if (!body || body === '<p></p>') return
  emit('reply', replyBody.value, currentDraftId.value ?? undefined, props.me?.personalFrom ? fromIdentity.value : undefined)
}

function submitContact() {
  const name = contactName.value.trim()
  if (!name) return
  emit('createContact', name)
  showCreateContact.value = false
}

// How this conversation entered the inbox (email / form / staff) — read-at-a-
// glance badge in the header.
const sourceMeta = computed(() => INBOX_SOURCE_META[props.thread.conversation.source])
// Applied tags as visible chips (the picker edits; these show). Slugs missing
// from the palette (deleted tag) still render, by slug, in neutral.
const appliedTags = computed(() =>
  props.thread.conversation.tags.map(slug =>
    props.palette.find(t => t.slug === slug) ?? { slug, name: slug, color: 'neutral' as const }
  )
)

// Less frequent conversation actions, kept behind the header's "more" menu.
const headerMenuItems = computed(() => {
  const items: DropdownMenuItem[] = []
  if (!props.thread.conversation.needsReview) {
    items.push({ label: 'Flag for review', icon: 'i-lucide-flag', onSelect: () => emit('patch', { needsReview: true }) })
  }
  if (!props.thread.contacts.length && props.thread.capabilities.canCreateContact) {
    items.push({
      label: 'Create contact',
      icon: 'i-lucide-user-plus',
      onSelect: () => {
        contactName.value = props.thread.conversation.counterpartyName || ''
        showCreateContact.value = true
      }
    })
  }
  if (canAddKnowledge.value) {
    items.push({ label: 'Add to knowledge base', icon: 'i-lucide-book-plus', onSelect: () => emit('addKnowledge') })
  }
  return items
})

const viewTabs = [
  { key: 'conversation' as const, label: 'Conversation' },
  { key: 'notes' as const, label: 'Notes & activity' }
]
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0 min-h-0">
    <header class="px-4 pt-3 border-b border-(--ui-border)">
      <div class="flex items-center flex-wrap lg:flex-nowrap gap-1.5 min-w-0">
        <slot name="back" />
        <h2 class="font-semibold truncate flex-1 min-w-0 text-(--ui-text-highlighted)">
          {{ thread.conversation.subject || '(no subject)' }}
        </h2>
        <!-- Below lg the triage controls drop to their own row under the subject. -->
        <div class="flex items-center gap-1.5 order-last basis-full -ml-2 lg:order-none lg:basis-auto lg:ml-0">
          <USelect v-model="statusValue" :items="statusItems" size="xs" variant="ghost" class="w-24" aria-label="Status" />
          <USelect v-model="assigneeValue" :items="assigneeItems" size="xs" variant="ghost" class="w-36" aria-label="Assignee" />
          <UButton
            v-if="thread.conversation.needsReview"
            label="Mark reviewed"
            icon="i-lucide-shield-check"
            size="xs"
            color="warning"
            variant="subtle"
            class="ml-auto lg:ml-0 lg:order-first"
            @click="emit('patch', { needsReview: false })"
          />
        </div>
        <UDropdownMenu v-if="headerMenuItems.length" :items="headerMenuItems" :content="{ align: 'end' }">
          <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" aria-label="More actions" />
        </UDropdownMenu>
      </div>
      <div class="flex items-center gap-x-2 gap-y-1 flex-wrap text-sm mt-0.5">
        <span v-if="thread.conversation.counterpartyName" class="text-(--ui-text) truncate">
          {{ thread.conversation.counterpartyName }}
        </span>
        <span class="text-(--ui-text-muted) truncate">{{ thread.channel?.value }}</span>
        <UTooltip v-if="thread.channel?.verified" text="Address ownership verified — authenticated inbound mail or a confirmed link">
          <UIcon name="i-lucide-badge-check" class="size-4 shrink-0 text-(--ui-success)" />
        </UTooltip>
        <UTooltip v-else-if="thread.channel" text="Unverified — no authenticated mail or confirmation click from this address yet">
          <UIcon name="i-lucide-badge-alert" class="size-4 shrink-0 text-(--ui-warning)" />
        </UTooltip>
        <UTooltip v-if="sourceMeta" :text="`Came in by ${sourceMeta.label.toLowerCase()}`">
          <UIcon :name="sourceMeta.icon" class="size-4 shrink-0 text-(--ui-text-dimmed)" />
        </UTooltip>
        <UTooltip v-if="suppressionMeta" :text="`${suppressionMeta.label} · since ${suppressionMeta.since}`">
          <UBadge label="Not receiving" color="error" size="sm" variant="solid" icon="i-lucide-mail-x" />
        </UTooltip>
        <UBadge v-if="thread.channel?.blocked" label="Blocked sender" color="error" size="sm" variant="subtle" />
        <ULink
          v-for="contact in thread.contacts"
          :key="contact.id"
          :to="crmPath(`/contacts/${contact.id}`)"
          class="flex items-center gap-1 text-sm text-(--ui-primary) hover:underline"
        >
          <UIcon name="i-lucide-contact" class="size-3.5 shrink-0" />
          {{ contact.name }}
        </ULink>
        <span
          v-for="t in appliedTags"
          :key="t.slug"
          class="flex items-center gap-1 text-xs text-(--ui-text-muted)"
        >
          <span class="size-1.5 rounded-full" :style="{ backgroundColor: inboxTagDotColor(t.color) }" />
          {{ t.name }}
        </span>
        <InboxTagPicker
          :palette="palette"
          :selected="thread.conversation.tags"
          @set-tags="emit('setTags', $event)"
          @create-tag="(name, color) => emit('createTag', name, color)"
          @delete-tag="emit('deleteTag', $event)"
        />
      </div>
      <nav class="flex gap-4 mt-1">
        <button
          v-for="tab in viewTabs"
          :key="tab.key"
          type="button"
          class="py-2 text-xs border-b-2 -mb-px transition-colors"
          :class="view === tab.key
            ? 'border-(--ui-primary) text-(--ui-text-highlighted) font-medium'
            : 'border-transparent text-(--ui-text-muted) hover:text-(--ui-text)'"
          @click="view = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>
    </header>

    <template v-if="view === 'conversation'">
      <div class="flex-1 overflow-y-auto p-4 space-y-3">
        <!-- An empty shell means the origin row committed but the message
             never persisted (a failed webhook awaiting redelivery, or one
             that never came back) — say so rather than showing a blank pane. -->
        <UAlert
          v-if="!thread.messages.length"
          icon="i-lucide-mail-question"
          color="warning"
          variant="subtle"
          title="No messages stored"
          description="This conversation exists but its message content was never stored — the original delivery may have failed and could still be retried by the mail provider."
        />
        <InboxMessageBubble v-for="m in thread.messages" :key="m.id" :message="m" />
      </div>

    <footer
      v-if="thread.capabilities.canSend && thread.conversation.status !== 'spam'"
      class="border-t border-(--ui-border) p-3 space-y-2"
    >
      <div v-if="showDraftChips" class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-(--ui-text-muted)">Drafts</span>
        <UButtonGroup v-for="d in thread.drafts" :key="d.id" size="xs">
          <UButton
            :label="draftPreview(d)"
            icon="i-lucide-file-pen-line"
            color="neutral"
            :variant="currentDraftId === d.id ? 'soft' : 'ghost'"
            @click="loadDraft(d)"
          />
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Discard draft" @click="onDeleteDraft(d)" />
        </UButtonGroup>
      </div>
      <UAlert
        v-if="suppressionMeta"
        icon="i-lucide-mail-x"
        color="error"
        variant="subtle"
        title="Replies can't be delivered to this address"
        :description="`It is suppressed (${suppressionMeta.label.toLowerCase()}${suppressionMeta.detail ? ': ' + suppressionMeta.detail : ''}). A reply would fail at send time; an admin can clear the suppression under Suppressions if it was a false positive.`"
      />
      <UAlert
        v-else-if="!replyStatus.email"
        icon="i-lucide-mail-question"
        color="warning"
        variant="subtle"
        title="No address to reply to"
        description="This conversation's address record is missing, so a reply has no recipient."
      />
      <!-- AI review panel — reviewer-only (uncertainty, English gloss, sources);
           never part of the outbound email. -->
      <div
        v-if="aiMeta"
        class="rounded-md bg-(--ui-info)/5 border-l-2 border-(--ui-info) pl-3 pr-1 py-2 space-y-1.5 text-xs"
      >
        <div class="flex items-center gap-1.5">
          <UIcon name="i-lucide-sparkles" class="size-3.5 text-(--ui-info)" />
          <span class="font-medium text-(--ui-text)">AI draft</span>
          <span class="text-(--ui-text-dimmed)">· notes for you, not emailed</span>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="ghost"
            class="ml-auto"
            aria-label="Dismiss AI notes"
            @click="emit('dismissAiMeta')"
          />
        </div>
        <div v-if="aiMeta.uncertainty.length">
          <span class="font-medium text-(--ui-warning)">Check before sending</span>
          <ul class="list-disc pl-4 mt-0.5 text-(--ui-text-muted)">
            <li v-for="(u, i) in aiMeta.uncertainty" :key="i">
              {{ u }}
            </li>
          </ul>
        </div>
        <details v-if="showAiGloss">
          <summary class="cursor-pointer text-(--ui-text-muted)">
            English translation ({{ aiMeta.language }} draft)
          </summary>
          <div class="whitespace-pre-wrap mt-1 text-(--ui-text-muted)">
            {{ aiMeta.gloss }}
          </div>
        </details>
        <div v-if="aiMeta.sources.length" class="flex flex-wrap items-center gap-1">
          <span class="text-(--ui-text-muted)">Grounded on:</span>
          <UBadge
            v-for="(s, i) in aiMeta.sources"
            :key="i"
            :label="s"
            color="neutral"
            variant="subtle"
            size="sm"
          />
        </div>
      </div>

      <div class="rounded-lg border border-(--ui-border) focus-within:border-(--ui-border-accented) transition-colors">
        <div class="flex items-center flex-wrap gap-x-1.5 gap-y-1 px-3 py-1.5 border-b border-(--ui-border) text-xs min-w-0">
          <span class="text-(--ui-text-dimmed) shrink-0">To</span>
          <span v-if="replyStatus.email" class="truncate text-(--ui-text)">{{ replyStatus.email }}</span>
          <span v-else class="text-(--ui-text-dimmed)">no address</span>
          <template v-if="me?.personalFrom">
            <span class="text-(--ui-text-dimmed) shrink-0 ml-3">From</span>
            <USelect v-model="fromIdentity" :items="fromOptions" size="xs" variant="ghost" class="w-56 min-w-0" />
            <UButton
              v-if="fromIdentity === 'personal' && me?.signature"
              :label="showSignaturePreview ? 'Hide signature' : 'Signature'"
              size="xs"
              color="neutral"
              variant="link"
              class="shrink-0 ml-auto"
              @click="showSignaturePreview = !showSignaturePreview"
            />
            <span v-else class="text-(--ui-text-dimmed) truncate ml-auto">{{ signatureNotice }}</span>
          </template>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized, and it is the agent's own signature (self-XSS only) -->
        <div
          v-if="showSignaturePreview && fromIdentity === 'personal' && me?.signature"
          class="px-3 py-2 border-b border-(--ui-border) prose prose-sm dark:prose-invert max-w-none text-xs"
          v-html="inboxSanitizeDisplayHtml(me?.signature)"
        />
        <UEditor
          ref="replyEditor"
          v-model="replyBody"
          content-type="html"
          placeholder="Write your reply…"
          :image="true"
          :mention="false"
          :ui="{ base: 'px-3 sm:px-3 py-2 *:my-3' }"
          class="inbox-composer-editor min-h-24 max-h-40 lg:max-h-72 overflow-y-auto"
        />
        <div v-if="currentDraftAttachments.length" class="flex flex-wrap gap-1.5 px-3 pb-2">
          <UButtonGroup v-for="a in currentDraftAttachments" :key="a.id" size="xs">
            <UButton :label="a.filename || 'attachment'" icon="i-lucide-paperclip" color="neutral" variant="subtle" />
            <UButton icon="i-lucide-x" color="neutral" variant="subtle" aria-label="Remove attachment" @click="emit('removeAttachment', a.id)" />
          </UButtonGroup>
        </div>
        <div class="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-(--ui-border)">
          <div class="flex items-center gap-0.5 min-w-0">
            <UTooltip text="Attach files">
              <UButton
                icon="i-lucide-paperclip"
                size="sm"
                color="neutral"
                variant="ghost"
                aria-label="Attach files"
                :disabled="props.sending"
                @click="pickFiles"
              />
            </UTooltip>
            <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesPicked">
            <UTooltip v-if="props.uploadInlineImage" text="Insert image">
              <UButton
                icon="i-lucide-image"
                size="sm"
                color="neutral"
                variant="ghost"
                aria-label="Insert image"
                :loading="insertingImage"
                :disabled="props.sending || insertingImage"
                @click="pickImage"
              />
            </UTooltip>
            <input ref="imageInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden" @change="onImagePicked">
            <InboxCannedPicker :items="canned" @insert="insertCanned" />
            <UButton
              v-if="aiAvailable"
              icon="i-lucide-sparkles"
              label="AI draft"
              size="sm"
              color="info"
              variant="ghost"
              :disabled="props.sending"
              @click="emit('aiDraft')"
            />
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <UTooltip v-if="currentDraft" text="Discard draft">
              <UButton
                icon="i-lucide-trash-2"
                size="sm"
                color="neutral"
                variant="ghost"
                aria-label="Discard draft"
                :disabled="props.sending"
                @click="onDeleteDraft(currentDraft)"
              />
            </UTooltip>
            <UButton
              label="Save draft"
              size="sm"
              color="neutral"
              variant="ghost"
              :disabled="props.sending"
              @click="onSaveDraft"
            />
            <UButton
              label="Send"
              icon="i-lucide-send"
              size="sm"
              :loading="props.sending"
              :disabled="props.sending || !hasSendAddress || !canDeliver"
              @click="submitReply"
            />
          </div>
        </div>
      </div>
      <p v-if="!hasSendAddress" class="flex items-center gap-1.5 text-xs text-(--ui-text-warning)">
        <UIcon name="i-lucide-mail-warning" class="shrink-0" />
        <span>Sending is unavailable until this inbox has a shared contact address. You can still save this as a draft.</span>
      </p>
    </footer>
    </template>

    <InboxNotesTimeline v-else :conversation-id="thread.conversation.id" :users="assignees" :can-moderate="me?.canModerate ?? false" />

    <UModal v-model:open="confirmSpam" title="Mark as spam?">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          This blocks <span class="font-medium">{{ thread.channel?.value }}</span> — every conversation from
          this sender closes as spam and future mail is filed there silently.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" variant="ghost" color="neutral" @click="confirmSpam = false" />
          <UButton
            label="Block sender"
            color="error"
            @click="emit('patch', { status: 'spam' }); confirmSpam = false"
          />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="confirmClose" title="Close conversation?">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          Closing marks this conversation resolved and clears its review flag.
          A new message from the contact reopens it.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" variant="ghost" color="neutral" @click="confirmClose = false" />
          <UButton
            label="Close conversation"
            @click="emit('patch', { status: 'closed' }); confirmClose = false"
          />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="showCreateContact" title="Create contact">
      <template #body>
        <UFormField label="Name" required>
          <UInput v-model="contactName" placeholder="Contact name" class="w-full" autofocus @keydown.enter="submitContact" />
        </UFormField>
        <p class="text-xs text-(--ui-text-muted) mt-2">
          The contact is created with {{ thread.channel?.value }} as their primary email and linked to
          every conversation on that address.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" variant="ghost" color="neutral" @click="showCreateContact = false" />
          <UButton label="Create" @click="submitContact" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Match the size cap outbound mail applies per <img> at send time
   (inboxConstrainImages), so the composer shows what recipients will see. */
.inbox-composer-editor :deep(img) {
  max-width: 100%;
  max-height: 480px;
  height: auto;
}
</style>
