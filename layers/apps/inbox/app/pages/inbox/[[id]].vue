<script setup lang="ts">
// The shared inbox: rail (scope folders) · conversation list · thread.
// Selection rides the route (/inbox/:id) so threads are linkable; the org
// prefix on internal navigation is preserved by useInboxPath. All list state
// (scope/status/q) lives in the URL query.
import type { InboxTagColor } from '../../composables/useInboxTags'
import type { InboxAiMetadata } from '../../composables/useInboxThread'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const router = useRouter()
const inboxPath = useInboxPath()

const selectedId = computed(() => {
  const raw = route.params.id
  const id = Array.isArray(raw) ? raw[0] : raw
  return id || null
})

const { items, total, counts, tagCounts, pending, error, scope, status, q, tag, refresh, applyBulk } = useInboxConversations()
const { thread, error: threadError, refresh: refreshThread, patch, reply, saveDraft, deleteDraft, saveAiDraft, uploadAttachment, removeAttachment, uploadInlineImage, createContact } = useInboxThread(selectedId)
const { users: assignees } = useInboxAssignees()
const { palette, createTag, deleteTag, setConversationTags } = useInboxTags()
const { items: cannedItems, failed: cannedFailed, refresh: refreshCanned, create: createCanned, update: updateCanned, remove: removeCanned } = useInboxCanned()
const { me, saveIdentity } = useInboxMe()
const { hasPermission } = usePermissions()
const { available: aiAvailable } = useInboxAiStatus('inbox.draft')

const toast = useToast()
const showCompose = ref(false)
const showCanned = ref(false)
// The manager edits the live org list — refetch on every open so it never
// shows a stale set, and make a load failure visible (the picker deliberately
// degrades silently; a management surface must not).
watch(showCanned, async (v) => {
  if (!v) return
  await refreshCanned()
  if (cannedFailed.value) {
    toast.add({ title: 'Could not load canned responses', color: 'error' })
  }
})
const showIdentity = ref(false)
const showSuppressions = ref(false)
const showAiDraft = ref(false)
const showAddKb = ref(false)
const showKnowledge = ref(false)
const replying = ref(false)
const currentDraftId = ref<string | null>(null)
// Composer body + the loaded AI draft's reviewer pack (parent-owned so the AI
// modal can push a draft into the composer and surface its review panel).
const replyBody = ref('')
const aiMeta = ref<InboxAiMetadata | null>(null)

// The canned-response manager is a compose/reply-authority tool.
const canManageCanned = computed(() => hasPermission('inbox.send'))

// The middle-pane heading follows the active folder: a tag name when one is
// selected, otherwise the scope.
const viewLabel = computed(() => {
  if (tag.value) return palette.value.find(t => t.slug === tag.value)?.name ?? tag.value
  return scope.value === 'held' ? 'Needs review' : scope.value
})

function open(id: string) {
  router.push(withQuery(inboxPath(`/inbox/${id}`)))
}

// A new outbound conversation must appear in the list and rail counts right
// away, not on the next natural refetch.
function onComposeCreated(id: string) {
  refresh()
  open(id)
}

// Mobile folder access: the rail is hidden below lg, so the list header's
// view label doubles as a folder menu there (scopes + tag folders).
const mobileFolders = computed(() => {
  const scopeItems = [
    { label: 'Needs review', icon: 'i-lucide-shield-alert', onSelect: () => { scope.value = 'held' } },
    { label: 'All', icon: 'i-lucide-inbox', onSelect: () => { scope.value = 'all' } },
    { label: 'Unassigned', icon: 'i-lucide-user-x', onSelect: () => { scope.value = 'unassigned' } },
    { label: 'Mine', icon: 'i-lucide-user-check', onSelect: () => { scope.value = 'mine' } }
  ]
  const tagItems = palette.value.map(t => ({
    label: t.name,
    icon: 'i-lucide-tag',
    onSelect: () => { tag.value = t.slug }
  }))
  return tagItems.length ? [scopeItems, tagItems] : [scopeItems]
})

function withQuery(path: string) {
  return { path, query: route.query }
}

async function onPatch(body: { status?: string, assignedUserId?: string | null, needsReview?: boolean }) {
  const wasSpam = thread.value?.conversation.status === 'spam'
  try {
    await patch(body)
    await refresh()
    if (body.status === 'spam') {
      toast.add({ title: 'Marked as spam', icon: 'i-lucide-shield-ban', color: 'success' })
    } else if (wasSpam && body.status) {
      toast.add({ title: 'Removed from spam', icon: 'i-lucide-shield-check', color: 'success' })
    }
    // A confirmed close leaves the thread: it has dropped out of the working
    // list, so the pane returns to the folder instead of a resolved thread.
    if (body.status === 'closed') {
      router.push(withQuery(inboxPath('/inbox')))
    }
  } catch (err) {
    toast.add({ title: 'Update failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

// Bulk triage: rows checked in the list, acted on by the bar beneath it. The
// selection is dropped whenever the list context changes (the checked rows
// may no longer be visible) and after an action applies.
const selectedIds = ref<Set<string>>(new Set())
const bulkBusy = ref(false)
const confirmBulkClose = ref(false)
watch([scope, status, tag, q], () => { selectedIds.value = new Set() })

const allVisibleSelected = computed(() =>
  items.value.length > 0 && items.value.every(c => selectedIds.value.has(c.id))
)
function selectAllVisible() {
  selectedIds.value = new Set(items.value.map(c => c.id))
}
function clearSelection() {
  selectedIds.value = new Set()
}

// reka-ui selects reject '' as an item value — the unassigned sentinel is a
// real string swapped back to null on change.
const UNASSIGNED = '__none__'
// Spam is not offered: it blocklists the sender and stays a per-thread call.
const bulkStatusItems = [
  { label: 'Open', value: 'open' },
  { label: 'Pending', value: 'pending' },
  { label: 'Closed', value: 'closed' }
]
const bulkAssigneeItems = computed(() => [
  { label: 'Unassigned', value: UNASSIGNED },
  ...assignees.value.map(a => ({ label: a.displayName, value: a.id }))
])
const bulkTagItems = computed(() => palette.value.map(t => ({ label: t.name, value: t.slug })))
// The bar's triggers are narrow, so each dropdown sizes to its items instead
// of inheriting the trigger width.
const bulkMenuUi = { content: 'w-auto min-w-(--reka-combobox-trigger-width) max-w-64' }

async function onBulk(action: { status?: string, assignedUserId?: string | null, addTags?: string[] }) {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  bulkBusy.value = true
  try {
    const updated = await applyBulk(ids, action)
    toast.add({ title: `${updated} conversation${updated === 1 ? '' : 's'} updated`, icon: 'i-lucide-check', color: 'success' })
    clearSelection()
    // The open thread may be in the batch — refresh it alongside the list.
    const tasks: Promise<unknown>[] = [refresh()]
    if (selectedId.value && ids.includes(selectedId.value)) tasks.push(refreshThread())
    await Promise.all(tasks)
  } catch (err) {
    toast.add({ title: 'Bulk update failed', description: inboxErrorMessage(err), color: 'error' })
  } finally {
    bulkBusy.value = false
  }
}
function onBulkStatus(value: unknown) {
  if (typeof value !== 'string') return
  // Closing also clears review flags — worth a confirm, as on a single thread.
  if (value === 'closed') {
    confirmBulkClose.value = true
    return
  }
  onBulk({ status: value })
}
function onBulkAssign(value: unknown) {
  if (typeof value !== 'string') return
  onBulk({ assignedUserId: value === UNASSIGNED ? null : value })
}
function onBulkAddTag(value: unknown) {
  if (typeof value !== 'string') return
  onBulk({ addTags: [value] })
}

async function onReply(body: string, draftId?: string, fromIdentity?: 'personal' | 'contact') {
  replying.value = true
  try {
    await reply(body, draftId, fromIdentity)
    // Clear the composer only on a confirmed queue — a failed send keeps the
    // typed text, draft linkage, and AI review panel for retry.
    replyBody.value = ''
    currentDraftId.value = null
    aiMeta.value = null
    await refresh()
    toast.add({ title: 'Reply queued', icon: 'i-lucide-send', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Reply failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    replying.value = false
  }
}

async function onSaveDraft(body: string, fromIdentity?: 'personal' | 'contact') {
  try {
    const newId = await saveDraft(body, currentDraftId.value ?? undefined, fromIdentity)
    if (newId) currentDraftId.value = newId
    toast.add({ title: 'Draft saved', icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onDeleteDraft(draftId: string) {
  try {
    await deleteDraft(draftId)
  } catch (err) {
    toast.add({ title: 'Discard failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onAttachFiles(files: File[], body: string) {
  try {
    // Attachments need a draft to bind to — create one from the current body
    // if the composer isn't already editing a draft.
    let draftId = currentDraftId.value
    if (!draftId) {
      draftId = (await saveDraft(body)) ?? null
      currentDraftId.value = draftId
    }
    if (!draftId) return
    for (const f of files) await uploadAttachment(draftId, f)
  } catch (err) {
    toast.add({ title: 'Attachment failed', description: inboxErrorMessage(err), color: 'error' })
  }
}

async function onRemoveAttachment(attachmentId: string) {
  try {
    await removeAttachment(attachmentId)
  } catch (err) {
    toast.add({ title: 'Remove failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onCreateContact(name: string) {
  try {
    await createContact(name)
    toast.add({ title: 'Contact created', icon: 'i-lucide-user-plus', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Contact creation failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

// Tag mutations refresh both panes: the thread (its chips/picker state) and the
// list (row chips + rail tag counts change server-side).
async function onSetTags(slugs: string[]) {
  const id = selectedId.value
  if (!id) return
  try {
    await setConversationTags(id, slugs)
    await Promise.all([refreshThread(), refresh()])
  } catch (err) {
    toast.add({ title: 'Tagging failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onCreateTag(name: string, color: InboxTagColor) {
  const id = selectedId.value
  if (!id) return
  try {
    // Create-or-return, then assign to the open conversation in one step.
    const created = await createTag(name, color)
    const next = [...(thread.value?.conversation.tags ?? []), created.slug]
    await setConversationTags(id, next)
    await Promise.all([refreshThread(), refresh()])
  } catch (err) {
    toast.add({ title: 'Create tag failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onDeleteTag(slug: string) {
  try {
    // Server strips the slug from every conversation; refresh both panes so no
    // ghost chips linger, and drop the tag filter if it was the active folder.
    await deleteTag(slug)
    if (tag.value === slug) tag.value = ''
    await Promise.all([refreshThread(), refresh()])
  } catch (err) {
    toast.add({ title: 'Delete tag failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onCreateCanned(title: string, bodyHtml: string) {
  try {
    await createCanned(title, bodyHtml)
    toast.add({ title: 'Canned response saved', icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onUpdateCanned(id: string, title: string, bodyHtml: string) {
  try {
    await updateCanned(id, { title, bodyHtml })
    toast.add({ title: 'Canned response updated', icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Update failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onDeleteCanned(id: string) {
  try {
    await removeCanned(id)
    toast.add({ title: 'Canned response deleted', icon: 'i-lucide-trash-2', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Delete failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

// The AI modal generated a draft the reviewer chose; persist it as a shared
// ai_generated draft, load it into the composer, and surface its review panel.
async function onUseAiDraft({ html, text, meta }: { html: string, text: string, meta: InboxAiMetadata }) {
  try {
    const draftId = await saveAiDraft({ html, text, meta })
    currentDraftId.value = draftId ?? null
    replyBody.value = html
    aiMeta.value = meta
    await refresh()
    toast.add({ title: 'AI draft ready to review', icon: 'i-lucide-sparkles', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Could not save AI draft', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

async function onSaveIdentity(patch: { alias?: string | null, signature?: string | null }) {
  try {
    await saveIdentity(patch)
    toast.add({ title: 'Identity saved', icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Save failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <InboxRail v-model:scope="scope" v-model:tag="tag" :counts="counts" :tags="palette" :tag-counts="tagCounts" :show-settings="me?.canManageSettings ?? false" />

    <section class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <InboxUnconfiguredBanner
        v-if="me && !me.contactAddress"
        :can-manage-settings="me.canManageSettings"
      />

      <div class="flex-1 flex min-w-0 overflow-hidden">
        <div class="flex flex-col min-h-0" :class="selectedId ? 'hidden lg:flex' : 'flex w-full lg:w-auto'">
          <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-(--ui-border)">
            <div class="flex items-center gap-1.5 min-w-0">
              <UDropdownMenu :items="mobileFolders" class="lg:hidden">
                <UButton
                  :label="viewLabel"
                  trailing-icon="i-lucide-chevron-down"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="capitalize"
                />
              </UDropdownMenu>
              <span class="hidden lg:inline text-sm font-medium text-(--ui-text-muted) capitalize truncate">{{ viewLabel }}</span>
              <span class="text-xs text-(--ui-text-dimmed) shrink-0">{{ total }}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <UButton
                v-if="me"
                label="Identity"
                icon="i-lucide-signature"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="showIdentity = true"
              />
              <UButton
                v-if="canManageCanned"
                label="Canned"
                icon="i-lucide-message-square-text"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="showCanned = true"
              />
              <UButton
                v-if="canManageCanned"
                label="Suppressions"
                icon="i-lucide-mail-x"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="showSuppressions = true"
              />
              <UButton
                v-if="aiAvailable"
                label="Knowledge"
                icon="i-lucide-book-open"
                size="xs"
                color="neutral"
                variant="ghost"
                @click="showKnowledge = true"
              />
              <UButton label="New email" icon="i-lucide-pen-line" size="xs" @click="showCompose = true" />
            </div>
          </div>
          <InboxConversationList
            v-model:status="status"
            v-model:q="q"
            v-model:selected-ids="selectedIds"
            :items="items"
            :counts="counts"
            :pending="pending"
            :scope="scope"
            :selected-id="selectedId"
            :palette="palette"
            class="flex-1 min-h-0"
            @select="open"
          />
          <div
            v-if="selectedIds.size"
            class="w-full lg:w-96 shrink-0 flex items-center flex-wrap gap-2 px-3 py-2 border-t border-r border-(--ui-border) bg-(--ui-bg)"
          >
            <span class="text-xs font-semibold whitespace-nowrap">{{ selectedIds.size }} selected</span>
            <UButton
              v-if="!allVisibleSelected"
              :label="`Select all ${items.length}`"
              size="xs"
              variant="link"
              color="neutral"
              @click="selectAllVisible"
            />
            <div class="flex-1" />
            <USelectMenu
              :model-value="undefined"
              :items="bulkStatusItems"
              value-key="value"
              size="xs"
              placeholder="Set status"
              :disabled="bulkBusy"
              :ui="bulkMenuUi"
              class="min-w-28"
              @update:model-value="onBulkStatus"
            />
            <USelectMenu
              :model-value="undefined"
              :items="bulkAssigneeItems"
              value-key="value"
              size="xs"
              placeholder="Assign"
              :disabled="bulkBusy"
              :ui="bulkMenuUi"
              class="min-w-28"
              @update:model-value="onBulkAssign"
            />
            <USelectMenu
              v-if="bulkTagItems.length"
              :model-value="undefined"
              :items="bulkTagItems"
              value-key="value"
              size="xs"
              placeholder="Add tag"
              :disabled="bulkBusy"
              :ui="bulkMenuUi"
              class="min-w-28"
              @update:model-value="onBulkAddTag"
            />
            <UButton
              icon="i-lucide-x"
              size="xs"
              variant="ghost"
              color="neutral"
              aria-label="Clear selection"
              @click="clearSelection"
            />
          </div>
        </div>

        <template v-if="selectedId">
          <div class="lg:hidden absolute top-2 left-2 z-10">
            <UButton icon="i-lucide-arrow-left" variant="ghost" color="neutral" size="sm" :to="withQuery(inboxPath('/inbox'))" />
          </div>
          <InboxThread
            v-if="thread"
            v-model:draft-id="currentDraftId"
            v-model:reply-body="replyBody"
            :thread="thread"
            :assignees="assignees"
            :palette="palette"
            :canned="cannedItems"
            :me="me"
            :sending="replying"
            :upload-inline-image="uploadInlineImage"
            :ai-available="aiAvailable"
            :ai-meta="aiMeta"
            @patch="onPatch"
            @reply="onReply"
            @save-draft="onSaveDraft"
            @delete-draft="onDeleteDraft"
            @attach-files="onAttachFiles"
            @remove-attachment="onRemoveAttachment"
            @create-contact="onCreateContact"
            @set-tags="onSetTags"
            @create-tag="onCreateTag"
            @delete-tag="onDeleteTag"
            @ai-draft="showAiDraft = true"
            @add-knowledge="showAddKb = true"
            @dismiss-ai-meta="aiMeta = null"
            @load-draft-meta="aiMeta = $event"
          />
          <UEmpty
            v-else-if="threadError"
            icon="i-lucide-alert-triangle"
            title="Conversation unavailable"
            :description="threadError"
            variant="naked"
            class="m-auto"
          />
        </template>
        <UEmpty
          v-else
          icon="i-lucide-mails"
          title="Select a conversation"
          description="Pick a conversation from the list, or start a new email."
          variant="naked"
          class="m-auto hidden lg:flex"
        />
      </div>
    </section>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="absolute bottom-4 right-4 w-80" />

    <InboxComposeModal v-model:open="showCompose" @created="onComposeCreated" />

    <UModal v-model:open="confirmBulkClose" title="Close conversations?">
      <template #body>
        <p class="text-sm text-(--ui-text-muted)">
          Closing marks {{ selectedIds.size }} conversation{{ selectedIds.size === 1 ? '' : 's' }} resolved and
          clears their review flags. A new message from a contact reopens its conversation.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" variant="ghost" color="neutral" @click="confirmBulkClose = false" />
          <UButton
            label="Close conversations"
            @click="confirmBulkClose = false; onBulk({ status: 'closed' })"
          />
        </div>
      </template>
    </UModal>

    <InboxCannedManager
      v-if="canManageCanned"
      v-model:open="showCanned"
      :items="cannedItems"
      @create="onCreateCanned"
      @update="onUpdateCanned"
      @delete="onDeleteCanned"
    />

    <InboxIdentityModal v-if="me" v-model:open="showIdentity" :me="me" @save="onSaveIdentity" />

    <InboxSuppressionsModal
      v-if="canManageCanned"
      v-model:open="showSuppressions"
      :can-clear="me?.canModerate ?? false"
    />

    <InboxAiDraftModal
      v-if="thread"
      v-model:open="showAiDraft"
      :conversation-id="thread.conversation.id"
      @use="onUseAiDraft"
    />

    <InboxAddToKnowledgeBaseModal
      v-if="thread"
      v-model:open="showAddKb"
      :conversation-id="thread.conversation.id"
    />

    <InboxKnowledgeManager
      v-model:open="showKnowledge"
      :can-manage="canManageCanned"
    />
  </div>
</template>
