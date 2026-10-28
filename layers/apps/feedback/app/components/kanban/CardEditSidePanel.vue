<script setup lang="ts">
import type {
  KanbanCardModel,
  KanbanColumnModel,
  KanbanProjectModel,
  PostType
} from './types'
import { PHASES, DOING_COLUMN, FEEDBACK_LABELS, cardHeadline } from '../../composables/useCardUtils'

type Card = KanbanCardModel

interface MetaField {
  name: string
  label: string
  type: 'textarea' | 'select'
  // Select options as { label, value } pairs (label may differ from value).
  optionItems?: { label: string, value: string }[]
  placeholder?: string
}

const props = withDefaults(defineProps<{
  modelValue: boolean
  card: Card | null
  columns?: KanbanColumnModel[]
  projects?: KanbanProjectModel[]
  // Users assignable to cards (org members in multi-tenant mode, all users in
  // single mode), supplied by the board.
  users?: { id: string, display_name: string | null }[]
}>(), {
  columns: () => [],
  projects: () => [],
  users: () => []
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  save: [patch: Partial<Card> & { post_meta?: Record<string, any> }]
  delete: [cardId: string]
  replied: [card: Card]
}>()

const toast = useToast()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

// -------- Draft state (deep clone to avoid mutating parent) --------
interface DraftState {
  id: string
  title: string
  post_type: PostType
  assignee: string
  start_date: string
  due_date: string
  description: string
  is_done: boolean
  testing_results: string
  column_id: string
  project_id: string
  post_meta: Record<string, any>
}

function makeDraft(c: Card | null): DraftState | null {
  if (!c) return null
  return {
    id: c.id,
    title: c.title ?? '',
    post_type: (c.post_type ?? 'task') as PostType,
    assignee: c.assignee ?? '',
    start_date: c.start_date ?? '',
    due_date: c.due_date ?? '',
    description: c.description ?? '',
    is_done: !!c.is_done,
    testing_results: c.testing_results ?? '',
    column_id: c.column_id ?? '',
    project_id: c.project_id,
    post_meta: JSON.parse(JSON.stringify(c.post_meta ?? {}))
  }
}

const draft = ref<DraftState | null>(null)
const saving = ref(false)
const showDeleteConfirm = ref(false)

watch(
  () => [props.card, props.modelValue] as const,
  ([c, isOpen]) => {
    if (isOpen && c) {
      draft.value = makeDraft(c)
      showDeleteConfirm.value = false
    }
  },
  { immediate: true }
)

// -------- Post-type dynamic field spec (matches Svelte getPostMetaFields) --------
const planField: MetaField = {
  name: 'plan',
  label: 'Plan',
  type: 'textarea',
  placeholder: 'Step-by-step plan for this card.'
}

const POST_META_FIELDS: Record<string, MetaField[]> = {
  feedback: [
    { name: 'feedback_sub_type', label: 'Type', type: 'select', optionItems: [{ label: 'Bug', value: 'bug' }, { label: 'Idea', value: 'idea' }] },
    { name: 'problem_description', label: 'Problem', type: 'textarea', placeholder: 'What is wrong' },
    { name: 'suggested_fix', label: 'Suggested solution', type: 'textarea', placeholder: 'Change it to…' },
    planField
  ]
}

// Reka's Select primitive (underlying Nuxt UI) reserves empty-string as the
// "no selection" state, so we can't use it as a real option value. Use
// USelect's `placeholder` prop to render the "-- Select --" affordance.
const priorityQualOptions = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Highest', value: 'highest' }
]

// Post-type picker for non-feedback cards. Feedback cards keep their dedicated
// layout; changing a card's type swaps the panel body on the next open.
const postTypeOptions = [
  { label: 'Task', value: 'task' },
  { label: 'Feature', value: 'feature' },
  { label: 'Bug', value: 'bug' },
  { label: 'Artifact', value: 'artifact' },
  { label: 'Feedback', value: 'feedback' }
]

// Priority select value. The panel edits `post_meta.priority_qualitative`;
// cards created through the HTTP/MCP APIs carry severity in the `priority`
// column instead, so fall back to it (its `critical` maps to this
// vocabulary's `highest`) until an edit here writes the qualitative key.
const priorityQualValue = computed<string | undefined>(() => {
  const qual = getMeta('priority_qualitative')
  if (qual) return qual
  const col = String(props.card?.priority ?? '').toLowerCase()
  if (!col) return undefined
  if (col === 'critical') return 'highest'
  return priorityQualOptions.some(o => o.value === col) ? col : undefined
})

// Triage labels live in post_meta.labels as an array of catalog keys. The
// picker reads/writes that array; display text comes from the code catalog.
const labelOptions = FEEDBACK_LABELS.map(l => ({ label: l.label, value: l.value as string }))
const draftLabels = computed<string[]>({
  get: () => {
    const v = draft.value?.post_meta?.labels
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  },
  set: (vals: string[]) => setMeta('labels', vals)
})

// Feedback content fields, minus `plan` (which renders in the Progress
// section). The two text fields are labeled and ordered by type so the panel
// reads the way the submitter filled it in: a bug leads with its problem, an
// idea leads with the idea itself.
const feedbackContentFields = computed<MetaField[]>(() => {
  const typeField = (POST_META_FIELDS.feedback || []).find(f => f.name === 'feedback_sub_type')!
  if (getMeta('feedback_sub_type') === 'idea') {
    return [
      typeField,
      { name: 'suggested_fix', label: 'Idea', type: 'textarea', placeholder: 'The idea' },
      { name: 'problem_description', label: 'Problem it solves', type: 'textarea', placeholder: 'Why it helps' }
    ]
  }
  return [
    typeField,
    { name: 'problem_description', label: 'Problem', type: 'textarea', placeholder: 'What is wrong' },
    { name: 'suggested_fix', label: 'Suggested solution', type: 'textarea', placeholder: 'Change it to…' }
  ]
})

// -------- Feedback attachments (admin view) --------
interface FeedbackAttachment {
  id: string
  kind: 'screenshot' | 'attachment'
  filename: string
  mime_type: string
  size_bytes: number
  url: string
}

const attachments = ref<FeedbackAttachment[]>([])
const attachmentsLoading = ref(false)
const attachmentsError = ref('')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

async function loadAttachments(cardId: string) {
  attachments.value = []
  attachmentsError.value = ''
  attachmentsLoading.value = true
  try {
    const rows = await $fetch<FeedbackAttachment[]>(
      `/api/admin/feedback/${encodeURIComponent(cardId)}/attachments`
    )
    attachments.value = Array.isArray(rows) ? rows : []
  } catch (err: any) {
    attachmentsError.value = err?.data?.statusMessage || err?.message || 'Failed to load attachments'
  } finally {
    attachmentsLoading.value = false
  }
}

watch(
  () => [props.card?.id, props.card?.post_type, props.modelValue] as const,
  ([cardId, postType, isOpen]) => {
    if (isOpen && cardId && postType === 'feedback') {
      loadAttachments(cardId)
    } else {
      attachments.value = []
      attachmentsError.value = ''
    }
  },
  { immediate: true }
)

const screenshotAttachments = computed(() => attachments.value.filter(a => a.kind === 'screenshot'))
const fileAttachments = computed(() => attachments.value.filter(a => a.kind === 'attachment'))
function isImage(mime: string) { return typeof mime === 'string' && mime.startsWith('image/') }

// Lightbox modal for image attachments. Non-image attachments still open in a
// new tab via the regular anchor.
const lightboxOpen = ref(false)
const lightboxUrl = ref('')
const lightboxAlt = ref('')

function openLightbox(a: FeedbackAttachment) {
  lightboxUrl.value = a.url
  lightboxAlt.value = a.filename
  lightboxOpen.value = true
}


// Assignee picker options — member display names. Assignee is stored as the
// name string (the column and the card avatar both key off it).
const assigneeOptions = computed<string[]>(() =>
  props.users
    .map(u => u.display_name)
    .filter((n): n is string => !!n)
)

// Status and project pickers; saving moves the card when either changes.
const columnSelectItems = computed(() => props.columns.map(c => ({ label: c.name, value: c.id })))
const projectSelectItems = computed(() => props.projects.map(p => ({ label: p.name, value: p.id })))

// The phase picker only applies while a card sits in the DOING column.
const isDoing = computed(() =>
  props.columns.find(c => c.id === draft.value?.column_id)?.name === DOING_COLUMN
)
// Footer "Move to" menu: every column except the card's current one. Moving
// saves the panel's edits along with the new column.
const moveToItems = computed(() =>
  props.columns
    .filter(c => c.id !== props.card?.column_id)
    .map(c => ({
      label: c.name,
      icon: c.name === 'ARCHIVE' ? 'i-lucide-archive' : 'i-lucide-columns-3',
      onSelect: () => handleMoveTo(c.id)
    }))
)
const phaseSelectItems = PHASES.map(p => ({ label: p.label, value: p.value }))

// -------- Meta helpers --------
function getMeta(key: string): any {
  if (!draft.value) return ''
  const v = draft.value.post_meta?.[key]
  return v === undefined || v === null ? '' : v
}

function getClientContext(key: string): any {
  const ctx = draft.value?.post_meta?.client_context
  if (!ctx || typeof ctx !== 'object') return ''
  const v = (ctx as Record<string, any>)[key]
  return v === undefined || v === null ? '' : v
}

const deviceSummary = computed(() => {
  if (!draft.value || draft.value.post_type !== 'feedback') return ''
  const parts = [
    getClientContext('device_type'),
    getClientContext('platform'),
    getClientContext('browser')
  ].filter(Boolean)
  if (!parts.length) return ''
  const label = parts[0] === 'mobile' ? 'Mobile' : parts[0] === 'desktop' ? 'Desktop' : parts[0]
  return [label, ...parts.slice(1)].join(' · ')
})

const submittedAtFormatted = computed(() => {
  const iso = getMeta('submitted_at')
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
})

// Only http(s) page URLs become links; anything else is shown as text.
const pageUrlIsLink = computed(() => /^https?:\/\//i.test(String(getMeta('page_url'))))

// -------- Reply to submitter --------
// Only signed-in widget submissions carry an address to reply to.
const submitterEmail = computed(() => {
  const v = getMeta('submitter_email')
  return typeof v === 'string' ? v.trim() : ''
})

interface FeedbackReply {
  sent_at: string
  sent_by_name: string
  to: string
  subject: string
  message: string
}

const replies = computed<FeedbackReply[]>(() => {
  const v = draft.value?.post_meta?.replies
  return Array.isArray(v) ? v : []
})

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// The submitter's fields as the reply email quotes them.
const originalFeedback = computed(() => {
  const problem = String(getMeta('problem_description') || '').trim()
  const fix = String(getMeta('suggested_fix') || '').trim()
  const parts = getMeta('feedback_sub_type') === 'idea'
    ? [{ label: 'Idea', text: fix }, { label: 'Problem it solves', text: problem }]
    : [{ label: 'Problem', text: problem }, { label: 'Suggested solution', text: fix }]
  return parts.filter(p => p.text)
})

const replyOpen = ref(false)
const replySending = ref(false)
const replyForm = reactive({ subject: '', message: '' })

function openReply() {
  if (!props.card) return
  const headline = cardHeadline(props.card)
  const short = headline.length > 80 ? `${headline.slice(0, 77)}…` : headline
  const name = String(getMeta('submitter_name') || '').trim().split(/\s+/)[0]
  replyForm.subject = `Re: ${short}`
  replyForm.message = name ? `Hi ${name},\n\n` : ''
  replyOpen.value = true
}

async function sendReply() {
  if (!props.card || !draft.value || !replyForm.message.trim()) return
  replySending.value = true
  try {
    const updated = await $fetch<Card>(`/api/feedback/cards/${props.card.id}/reply`, {
      method: 'POST',
      body: { subject: replyForm.subject, message: replyForm.message }
    })
    // Carry the new reply into the draft so a later Save keeps it.
    draft.value.post_meta = { ...draft.value.post_meta, replies: updated.post_meta?.replies ?? [] }
    emit('replied', updated)
    replyOpen.value = false
    toast.add({ title: 'Reply sent', description: `Emailed ${submitterEmail.value}`, icon: 'i-lucide-send', color: 'success' })
  } catch (err: any) {
    toast.add({ title: 'Reply failed', description: err?.data?.statusMessage || err?.message, color: 'error' })
  } finally {
    replySending.value = false
  }
}

function setMeta(key: string, value: any) {
  if (!draft.value) return
  const next = { ...(draft.value.post_meta || {}) }
  if (value === '' || value === null || value === undefined) {
    next[key] = null
  } else {
    next[key] = value
  }
  draft.value.post_meta = next
}

// -------- Save / delete --------
// The card edits as a PATCH body. Title is an optional, user-owned headline; a
// blank title is stored as-is and the board falls back to the card's primary
// content (the problem for a bug, the idea for an idea) at display time — see
// cardHeadline.
function buildPatch(): Partial<Card> & { post_meta?: Record<string, any> } {
  const d = draft.value!
  return {
    title: d.title.trim(),
    post_type: d.post_type,
    description: d.description || null,
    assignee: d.assignee || null,
    start_date: d.start_date || null,
    due_date: d.due_date || null,
    is_done: d.is_done,
    testing_results: d.testing_results || null,
    ...(d.column_id ? { column_id: d.column_id } : {}),
    project_id: d.project_id,
    // Deep-merge: preserve any existing post_meta keys we didn't edit
    post_meta: {
      ...(props.card!.post_meta ?? {}),
      ...d.post_meta
    }
  }
}

async function handleSave() {
  if (!draft.value || !props.card) return
  saving.value = true
  try {
    emit('save', buildPatch())
  } finally {
    saving.value = false
  }
}

function handleDeleteClick() {
  showDeleteConfirm.value = true
}

function handleDeleteConfirm() {
  if (!draft.value) return
  emit('delete', draft.value.id)
  showDeleteConfirm.value = false
}

function handleDeleteCancel() {
  showDeleteConfirm.value = false
}

function handleMoveTo(columnId: string) {
  if (!draft.value || !props.card) return
  emit('save', { ...buildPatch(), column_id: columnId })
}

// -------- Agent bridge: format + clipboard --------
function determineActionFromColumn(columnName: string): string {
  const actions: Record<string, string> = {
    'BACKLOG': 'Plan',
    'PLANNING': 'Design & Architect',
    'BUILDING': 'Implement',
    'TESTING': 'Test & Validate',
    'DONE': 'Review & Document'
  }
  return actions[columnName] || 'Work On'
}

function getActionInstructions(action: string): string {
  const instructions: Record<string, string> = {
    'Plan': 'Help me triage this feedback item and decide on next steps.',
    'Design & Architect': 'Help me turn this feedback into a concrete design plan.',
    'Implement': 'Help me implement the change this feedback is asking for.',
    'Test & Validate': 'Help me verify this feedback has been addressed.',
    'Review & Document': 'Help me summarize what changed and notify the reporter.'
  }
  return instructions[action] || `Help me ${action.toLowerCase()} this feedback.`
}

function currentColumn(): KanbanColumnModel | null {
  if (!draft.value || !props.card) return null
  return props.columns.find(c => c.id === props.card!.column_id) || null
}

function currentProject(): KanbanProjectModel | null {
  if (!draft.value || !props.card) return null
  return props.projects.find(p => p.id === props.card!.project_id) || null
}

function buildCardForContext(): Card | null {
  if (!draft.value || !props.card) return null
  const d = draft.value
  return {
    ...props.card,
    title: d.title,
    post_type: d.post_type,
    assignee: d.assignee || null,
    start_date: d.start_date || null,
    due_date: d.due_date || null,
    description: d.description || null,
    is_done: d.is_done,
    testing_results: d.testing_results || null,
    post_meta: { ...(props.card.post_meta ?? {}), ...d.post_meta }
  }
}

function formatCardContextForAgent(): string {
  const card = buildCardForContext()
  if (!card) return ''
  const col = currentColumn()
  const proj = currentProject()
  const columnName = col?.name || 'Unknown'
  const projectName = proj?.name || 'Unknown'
  // In DOING the workflow stage is the card's phase; elsewhere it's the column.
  const phase = String(card.post_meta?.phase || 'backlog')
  const stage = col?.name === DOING_COLUMN ? phase.toUpperCase() : columnName
  const action = determineActionFromColumn(stage)
  const qual = card.post_meta?.priority_qualitative
  const quant = card.post_meta?.priority_quantitative
  const metaFields = POST_META_FIELDS[card.post_type] || []

  const typeSpecificLines = metaFields
    .map(f => {
      const v = card.post_meta?.[f.name]
      if (v === undefined || v === null || v === '') return null
      return `- **${f.label}:** ${String(v)}`
    })
    .filter(Boolean)
    .join('\n')

  const headline = cardHeadline(card)
  const lines: string[] = []
  lines.push(`# [${card.post_type}] ${headline}`)
  lines.push('')
  lines.push(`**Project:** ${projectName}`)
  lines.push(`**Column:** ${columnName}`)
  lines.push(`**Status:** ${card.is_done ? 'Done ✓' : 'In progress'}`)
  if (qual || quant != null) {
    const qualStr = qual || 'none'
    const quantStr = quant != null && quant !== '' ? `${quant}/100` : 'n/a'
    lines.push(`**Priority:** ${qualStr} (${quantStr})`)
  }
  if (card.assignee) lines.push(`**Assignee:** ${card.assignee}`)
  if (card.due_date) lines.push(`**Due:** ${card.due_date}`)
  lines.push('')
  lines.push('## Description')
  lines.push(card.description || '_No description provided_')
  if (card.post_meta?.plan) {
    lines.push('')
    lines.push('## Plan')
    lines.push(String(card.post_meta.plan))
  }
  const impl = card.post_meta?.implementation_plan ?? card.post_meta?.bug_repair_plan ?? ''
  if (impl) {
    lines.push('')
    lines.push('## Implementation')
    lines.push(String(impl))
  }
  if (card.testing_results) {
    lines.push('')
    lines.push('## Testing')
    lines.push(card.testing_results)
  }
  if (typeSpecificLines) {
    lines.push('')
    lines.push('## Type-specific')
    lines.push(typeSpecificLines)
  }
  if (attachments.value.length) {
    lines.push('')
    lines.push('## Attachments')
    lines.push('_Signed links, valid for 7 days._')
    for (const a of attachments.value) {
      const kind = a.kind === 'screenshot' ? 'Screenshot' : 'File'
      lines.push(`- ${kind}: [${a.filename}](${a.url}) (${a.mime_type}, ${formatBytes(a.size_bytes)})`)
    }
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`**Action:** ${action} — ${getActionInstructions(action)}`)
  lines.push(`**Context Path:** \`${projectName} / ${columnName} / ${headline}\``)
  lines.push('')
  const { screenshot_url: screenshotUrl, ...restMeta } = card.post_meta ?? {}
  const postMeta = screenshotUrl ? { ...restMeta, screenshot_url: screenshotUrl } : restMeta
  lines.push('## Post Meta (All Fields)')
  lines.push('```json')
  lines.push(JSON.stringify(postMeta, null, 2))
  lines.push('```')
  return lines.join('\n')
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to fallback
  }
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-999999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function handleCopyForAgent() {
  const text = formatCardContextForAgent()
  const ok = await copyToClipboard(text)
  if (ok) {
    toast.add({
      title: 'Copied to clipboard',
      description: 'Card context copied — paste into your AI agent.',
      icon: 'i-lucide-clipboard',
      color: 'success'
    })
  } else {
    toast.add({
      title: 'Copy failed',
      description: 'Unable to access the clipboard.',
      color: 'error'
    })
  }
}
</script>

<template>
  <USlideover v-model:open="open" side="right" :ui="{ content: 'max-w-lg' }">
    <template #content>
      <div v-if="draft" class="flex h-full flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between border-b border-(--ui-border) px-4 py-3 gap-2">
          <h2 class="text-lg font-semibold shrink-0">Edit Card</h2>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-clipboard"
              title="Copy this card's full context to paste into an AI assistant"
              @click="handleCopyForAgent"
            >
              Copy for AI
            </UButton>
            <UButton variant="ghost" icon="i-lucide-x" aria-label="Close" @click="open = false" />
          </div>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          <!-- Feedback: single-column 3-section layout -->
          <div v-if="draft.post_type === 'feedback'" class="space-y-6">
            <!-- Section 1: Submitter · From · Device · Date (compact info bar) -->
            <section class="space-y-1.5 text-sm">
              <div v-if="getMeta('submitter_name') || submittedAtFormatted || deviceSummary" class="flex flex-wrap items-center gap-x-4 gap-y-1 text-(--ui-text-muted)">
                <span v-if="getMeta('submitter_name')" class="inline-flex items-center gap-1.5">
                  <UIcon name="i-lucide-user" class="shrink-0" />
                  <span class="text-(--ui-text)">{{ getMeta('submitter_name') }}</span>
                </span>
                <span v-if="submittedAtFormatted" class="inline-flex items-center gap-1.5">
                  <UIcon name="i-lucide-calendar" class="shrink-0" />
                  <span>{{ submittedAtFormatted }}</span>
                </span>
                <span v-if="deviceSummary" class="inline-flex items-center gap-1.5">
                  <UIcon
                    :name="getClientContext('is_mobile') ? 'i-lucide-smartphone' : 'i-lucide-monitor'"
                    class="shrink-0"
                  />
                  <span>{{ deviceSummary }}</span>
                </span>
              </div>
              <a
                v-if="pageUrlIsLink"
                :href="getMeta('page_url')"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1.5 text-(--ui-primary) hover:underline break-all"
              >
                <UIcon name="i-lucide-external-link" class="shrink-0" />
                <span>{{ getMeta('page_url') }}</span>
              </a>
              <span
                v-else-if="getMeta('page_url')"
                class="break-all text-(--ui-text-muted)"
              >{{ getMeta('page_url') }}</span>
              <div v-if="submitterEmail" class="flex items-center justify-between gap-2">
                <span class="inline-flex min-w-0 items-center gap-1.5 text-(--ui-text-muted)">
                  <UIcon name="i-lucide-mail" class="shrink-0" />
                  <span class="truncate">{{ submitterEmail }}</span>
                </span>
                <UButton
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-lucide-reply"
                  title="Email the submitter"
                  @click="openReply"
                >
                  Reply
                </UButton>
              </div>
              <p v-if="!getMeta('submitter_name') && !getMeta('page_url') && !deviceSummary && !submittedAtFormatted" class="text-(--ui-text-muted) italic">
                No user or device info captured.
              </p>
            </section>

            <!-- Section 2: Feedback -->
            <section class="space-y-4 pt-4 border-t border-(--ui-border)">
              <h3 class="text-sm font-semibold text-(--ui-text-muted) uppercase tracking-wide">
                Feedback
              </h3>
              <UFormField label="Title" help="Shown on the board. Leave blank to use the problem text.">
                <UInput
                  v-model="draft.title"
                  placeholder="Leave blank to use the problem text"
                  class="w-full"
                />
              </UFormField>
              <UFormField v-for="f in feedbackContentFields" :key="f.name" :label="f.label">
                <UTextarea
                  v-if="f.type === 'textarea'"
                  :rows="3"
                  autoresize
                  :maxrows="20"
                  :model-value="getMeta(f.name)"
                  :placeholder="f.placeholder || ''"
                  class="w-full"
                  @update:model-value="(v: any) => setMeta(f.name, v)"
                />
                <USelect
                  v-else
                  :model-value="getMeta(f.name) || undefined"
                  :items="f.optionItems || []"
                  placeholder="-- Select --"
                  class="w-full"
                  @update:model-value="(v: any) => setMeta(f.name, v)"
                />
              </UFormField>
            </section>

            <!-- Section 2b: Attachments -->
            <section class="space-y-3 pt-4 border-t border-(--ui-border)">
              <h3 class="text-sm font-semibold text-(--ui-text-muted) uppercase tracking-wide">
                Attachments
              </h3>
              <div v-if="attachmentsLoading" class="text-sm text-(--ui-text-muted) italic">
                Loading…
              </div>
              <div v-else-if="attachmentsError" class="text-sm text-(--ui-error)">
                {{ attachmentsError }}
              </div>
              <div v-else-if="!attachments.length" class="text-sm text-(--ui-text-muted) italic">
                No screenshots or files attached.
              </div>
              <div v-else class="space-y-3">
                <div v-if="screenshotAttachments.length" class="space-y-2">
                  <div class="text-xs font-medium text-(--ui-text-muted)">Screenshot</div>
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="a in screenshotAttachments"
                      :key="a.id"
                      type="button"
                      class="block w-32 rounded border border-(--ui-border) overflow-hidden hover:border-(--ui-primary) transition-colors text-left cursor-zoom-in"
                      :title="`${a.filename} · ${formatBytes(a.size_bytes)}`"
                      @click="openLightbox(a)"
                    >
                      <img :src="a.url" :alt="a.filename" class="w-full h-24 object-cover bg-(--ui-bg-muted)" />
                      <div class="px-2 py-1 text-xs truncate">{{ a.filename }}</div>
                    </button>
                  </div>
                </div>
                <div v-if="fileAttachments.length" class="space-y-2">
                  <div class="text-xs font-medium text-(--ui-text-muted)">Files</div>
                  <ul class="space-y-1">
                    <li v-for="a in fileAttachments" :key="a.id">
                      <button
                        v-if="isImage(a.mime_type)"
                        type="button"
                        class="flex w-full items-center gap-2 px-2 py-1.5 rounded border border-(--ui-border) hover:border-(--ui-primary) transition-colors text-left cursor-zoom-in"
                        @click="openLightbox(a)"
                      >
                        <img :src="a.url" :alt="a.filename" class="w-8 h-8 object-cover rounded shrink-0" />
                        <span class="flex-1 truncate text-sm">{{ a.filename }}</span>
                        <span class="text-xs text-(--ui-text-muted) shrink-0">{{ formatBytes(a.size_bytes) }}</span>
                      </button>
                      <a
                        v-else
                        :href="a.url"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex items-center gap-2 px-2 py-1.5 rounded border border-(--ui-border) hover:border-(--ui-primary) transition-colors"
                      >
                        <UIcon name="i-lucide-paperclip" class="shrink-0" />
                        <span class="flex-1 truncate text-sm">{{ a.filename }}</span>
                        <span class="text-xs text-(--ui-text-muted) shrink-0">{{ formatBytes(a.size_bytes) }}</span>
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
            </section>

            <!-- Section 2c: Replies sent to the submitter -->
            <section v-if="replies.length" class="space-y-3 pt-4 border-t border-(--ui-border)">
              <h3 class="text-sm font-semibold text-(--ui-text-muted) uppercase tracking-wide">
                Replies
              </h3>
              <div
                v-for="(r, i) in replies"
                :key="`${r.sent_at}-${i}`"
                class="rounded-md bg-(--ui-bg-elevated)/50 px-3 py-2 space-y-1"
              >
                <div class="flex flex-wrap items-center gap-x-2 text-xs text-(--ui-text-muted)">
                  <UIcon name="i-lucide-send" class="shrink-0" />
                  <span class="text-(--ui-text)">{{ r.sent_by_name }}</span>
                  <span>→ {{ r.to }}</span>
                  <span>· {{ formatDateTime(r.sent_at) }}</span>
                </div>
                <p class="text-sm whitespace-pre-wrap break-words">{{ r.message }}</p>
              </div>
            </section>

          </div>

          <!-- Task / feature / bug / artifact: free-form details -->
          <div v-else class="space-y-6">
            <section class="space-y-4">
              <h3 class="text-sm font-semibold text-(--ui-text-muted) uppercase tracking-wide">
                Details
              </h3>
              <UFormField label="Title">
                <UInput v-model="draft.title" placeholder="One-line summary" class="w-full" />
              </UFormField>
              <UFormField label="Type">
                <USelect
                  :model-value="draft.post_type"
                  :items="postTypeOptions"
                  class="w-full"
                  @update:model-value="(v: any) => { if (draft) draft.post_type = v }"
                />
              </UFormField>
              <UFormField label="Description">
                <UTextarea
                  v-model="draft.description"
                  :rows="10"
                  placeholder="What, where, why — markdown supported."
                  class="w-full"
                />
              </UFormField>
            </section>
          </div>

          <!-- Coordination — all post types -->
          <section class="space-y-4 pt-4 border-t border-(--ui-border)">
            <h3 class="text-sm font-semibold text-(--ui-text-muted) uppercase tracking-wide">
              Coordination
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <UFormField label="Status">
                <USelect
                  v-model="draft.column_id"
                  :items="columnSelectItems"
                  placeholder="-- Select --"
                  class="w-full"
                />
              </UFormField>
              <UFormField v-if="projectSelectItems.length" label="Project">
                <USelect
                  v-model="draft.project_id"
                  :items="projectSelectItems"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField v-if="isDoing" label="Phase">
              <USelect
                :model-value="getMeta('phase') || 'backlog'"
                :items="phaseSelectItems"
                class="w-full"
                @update:model-value="(v: any) => setMeta('phase', v)"
              />
            </UFormField>
            <UFormField label="Assignee">
              <USelectMenu
                v-model="draft.assignee"
                :items="assigneeOptions"
                placeholder="Unassigned"
                :clear="true"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Priority">
              <USelect
                :model-value="priorityQualValue"
                :items="priorityQualOptions"
                placeholder="-- Select --"
                class="w-full"
                @update:model-value="(v: any) => setMeta('priority_qualitative', v)"
              />
            </UFormField>
            <UFormField label="Labels">
              <USelectMenu
                v-model="draftLabels"
                :items="labelOptions"
                value-key="value"
                label-key="label"
                multiple
                placeholder="No labels"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Plan">
              <UTextarea
                :rows="3"
                :model-value="getMeta('plan')"
                :placeholder="planField.placeholder || ''"
                class="w-full"
                @update:model-value="(v: any) => setMeta('plan', v)"
              />
            </UFormField>
            <UFormField label="Testing Results">
              <UTextarea
                v-model="draft.testing_results"
                :rows="3"
                placeholder="Test results, feedback, notes..."
                class="w-full"
              />
            </UFormField>
          </section>
        </div>

        <!-- Footer -->
        <div class="border-t border-(--ui-border) px-4 py-3">
          <div v-if="showDeleteConfirm" class="flex flex-col gap-2">
            <div class="text-sm font-medium text-(--ui-color-error-500)">
              Are you sure you want to delete this card?
            </div>
            <div class="flex gap-2">
              <UButton color="error" @click="handleDeleteConfirm">Yes, delete</UButton>
              <UButton variant="ghost" @click="handleDeleteCancel">Cancel</UButton>
            </div>
          </div>
          <div v-else class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UButton color="error" variant="outline" icon="i-lucide-trash-2" @click="handleDeleteClick">
                Delete
              </UButton>
              <UDropdownMenu v-if="moveToItems.length" :items="moveToItems" :content="{ side: 'top', align: 'start' }">
                <UButton color="neutral" variant="soft" icon="i-lucide-move-right" trailing-icon="i-lucide-chevron-up">
                  Move to
                </UButton>
              </UDropdownMenu>
            </div>
            <div class="flex items-center gap-2">
              <UButton variant="ghost" @click="open = false">Cancel</UButton>
              <UButton :loading="saving" icon="i-lucide-save" @click="handleSave">Save</UButton>
            </div>
          </div>
        </div>
      </div>
    </template>
  </USlideover>

  <UModal
    v-model:open="replyOpen"
    :title="`Reply to ${getMeta('submitter_name') || submitterEmail}`"
    description="Sent by email. Their original feedback is quoted below your message."
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="To">
          <UInput :model-value="submitterEmail" disabled icon="i-lucide-mail" class="w-full" />
        </UFormField>
        <UFormField label="Subject">
          <UInput v-model="replyForm.subject" class="w-full" />
        </UFormField>
        <UFormField label="Message" required>
          <UTextarea v-model="replyForm.message" :rows="8" autofocus autoresize class="w-full" />
        </UFormField>
        <div v-if="originalFeedback.length" class="space-y-2">
          <div class="text-xs font-medium text-(--ui-text-muted)">
            They wrote{{ submittedAtFormatted ? ` on ${submittedAtFormatted}` : '' }}
          </div>
          <div class="border-l-4 border-(--ui-border-accented) pl-3 space-y-2 text-sm text-(--ui-text-muted)">
            <div v-for="p in originalFeedback" :key="p.label">
              <div class="font-medium text-(--ui-text-toned)">{{ p.label }}</div>
              <p class="whitespace-pre-wrap break-words">{{ p.text }}</p>
            </div>
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" @click="replyOpen = false">Cancel</UButton>
        <UButton
          icon="i-lucide-send"
          :loading="replySending"
          :disabled="!replyForm.message.trim()"
          @click="sendReply"
        >
          Send
        </UButton>
      </div>
    </template>
  </UModal>

  <UModal v-model:open="lightboxOpen" fullscreen :close="false">
    <template #content>
      <div class="relative w-screen h-screen bg-black flex items-center justify-center">
        <img
          :src="lightboxUrl"
          :alt="lightboxAlt"
          class="max-h-screen max-w-full w-auto h-auto object-contain"
        />
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="solid"
          size="sm"
          class="absolute top-3 right-3"
          aria-label="Close"
          @click="lightboxOpen = false"
        />
        <a
          :href="lightboxUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="absolute bottom-3 right-3 px-2 py-1 rounded bg-black/60 text-white text-xs hover:bg-black/80"
        >Open original ↗</a>
      </div>
    </template>
  </UModal>
</template>
