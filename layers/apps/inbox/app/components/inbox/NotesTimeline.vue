<script setup lang="ts">
// The "Notes & Activity" tab body: a rich note composer (formatting + inline
// @mentions of teammates) and the merged newest-first feed of internal notes
// and audit activity. Own notes are editable/removable inline; admins can
// moderate anyone's note; system notes and activity rows are read-only.
// Mention recipients ride the note markup — the server extracts and validates
// them from the sanitized body.
import type { InboxAssignee } from '../../composables/useInboxThread'
import type { InboxTimelineEntry } from '../../composables/useInboxNotesTimeline'

const props = defineProps<{ conversationId: string, users: InboxAssignee[], canModerate?: boolean }>()

const { user } = useAuth()
const currentUserId = computed(() => (user.value as { id?: string } | null)?.id ?? null)
const toast = useToast()

const { entries, hasMore, pending, error, refresh, loadOlder, post, editNote, removeNote } = useInboxNotesTimeline(() => props.conversationId)
defineExpose({ refresh })

const noteBody = ref('')
const posting = ref(false)

const mentionItems = computed(() => props.users.map(u => ({ id: u.id, label: u.displayName })))
// The editors scroll inside a capped height, so the mention menu mounts on body to overlay instead of being clipped.
const mentionMenuParent = () => document.body

function hasContent(html: string): boolean {
  return !!html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
}

async function submitNote() {
  if (!hasContent(noteBody.value) || posting.value) return
  posting.value = true
  try {
    await post(noteBody.value)
    noteBody.value = ''
  } catch (err) {
    toast.add({ title: 'Note failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    posting.value = false
  }
}

// Inline edit state (one note at a time).
const editingId = ref<string | null>(null)
const editBody = ref('')
function startEdit(id: string, body: string) {
  editingId.value = id
  editBody.value = body
}
async function saveEdit() {
  const id = editingId.value
  if (!id || !hasContent(editBody.value)) { editingId.value = null; return }
  try {
    await editNote(id, editBody.value)
  } catch (err) {
    toast.add({ title: 'Edit failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    editingId.value = null
  }
}
async function onRemove(id: string) {
  try {
    await removeNote(id)
  } catch (err) {
    toast.add({ title: 'Delete failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  }
}

const ACTIVITY_ICON: Record<string, string> = {
  inbox_conversation_created: 'i-lucide-sparkles',
  inbox_inbound_received: 'i-lucide-mail',
  inbox_reply_queued: 'i-lucide-send',
  inbox_status_changed: 'i-lucide-circle-dot',
  inbox_assigned: 'i-lucide-user-check',
  inbox_unassigned: 'i-lucide-user-x',
  inbox_spam_marked: 'i-lucide-shield-ban',
  inbox_spam_unmarked: 'i-lucide-shield-check',
  inbox_delivery_delivered: 'i-lucide-check-check',
  inbox_delivery_failed: 'i-lucide-x-circle',
  inbox_ai_draft_saved: 'i-lucide-sparkles',
  inbox_tags_updated: 'i-lucide-tag'
}
function activityIcon(eventType: string): string {
  return ACTIVITY_ICON[eventType] ?? 'i-lucide-activity'
}
function isOwn(e: InboxTimelineEntry): boolean {
  return e.kind === 'note' && e.note.authorId !== null && e.note.authorId === currentUserId.value
}
// The moderation bar: own notes always, anyone's note for an admin — but
// never system notes (null author; the server refuses those too).
function canManage(e: InboxTimelineEntry): boolean {
  if (e.kind !== 'note' || e.note.authorId === null) return false
  return isOwn(e) || props.canModerate === true
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div class="p-3 border-b border-(--ui-border) space-y-2">
      <UEditor
        v-slot="{ editor }"
        v-model="noteBody"
        content-type="html"
        :image="false"
        placeholder="Add an internal note… (only staff see this, @ mentions a teammate)"
        :ui="{ base: 'min-h-28' }"
        class="max-h-64 overflow-y-auto rounded-md border border-(--ui-border) text-sm"
        @keydown.meta.enter="submitNote"
        @keydown.ctrl.enter="submitNote"
      >
        <UEditorMentionMenu :editor="editor" :items="mentionItems" :append-to="mentionMenuParent" />
      </UEditor>
      <div class="flex justify-end">
        <UButton
          label="Add note"
          icon="i-lucide-message-square-plus"
          size="xs"
          :loading="posting"
          :disabled="!hasContent(noteBody)"
          @click="submitNote"
        />
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-3">
      <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      <div v-if="pending && !entries.length" class="grid place-items-center py-8 text-(--ui-text-muted)">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      </div>
      <p v-else-if="!entries.length" class="text-sm text-(--ui-text-dimmed) text-center py-8">
        No notes or activity yet.
      </p>

      <template v-for="entry in entries" :key="entry.id">
        <div v-if="entry.kind === 'note'" class="flex gap-2">
          <UAvatar
            v-bind="userAvatarProps({ id: entry.note.authorId, name: entry.note.authorName, image: entry.note.authorAvatarUrl })"
            size="xs"
            class="mt-0.5 shrink-0"
          />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-medium text-(--ui-text-highlighted) truncate">{{ entry.note.authorName }}</span>
              <RelativeTime :value="entry.note.createdAt" class="text-(--ui-text-dimmed)" />
              <span v-if="entry.note.editedAt" class="text-(--ui-text-dimmed)">(edited)</span>
              <template v-if="canManage(entry) && editingId !== entry.note.id">
                <UButton icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" class="ml-auto" aria-label="Edit note" @click="startEdit(entry.note.id, entry.note.body)" />
                <UButton icon="i-lucide-trash-2" size="xs" variant="ghost" color="error" aria-label="Delete note" @click="onRemove(entry.note.id)" />
              </template>
            </div>
            <template v-if="editingId === entry.note.id">
              <UEditor
                v-slot="{ editor }"
                v-model="editBody"
                content-type="html"
                :image="false"
                class="min-h-16 max-h-48 overflow-y-auto rounded-md border border-(--ui-border) text-sm mt-1"
                @keydown.meta.enter="saveEdit"
                @keydown.ctrl.enter="saveEdit"
                @keydown.esc="editingId = null"
              >
                <UEditorMentionMenu :editor="editor" :items="mentionItems" :append-to="mentionMenuParent" />
              </UEditor>
              <div class="flex justify-end gap-2 mt-1">
                <UButton label="Cancel" size="xs" variant="ghost" color="neutral" @click="editingId = null" />
                <UButton label="Save" size="xs" @click="saveEdit" />
              </div>
            </template>
            <!-- eslint-disable-next-line vue/no-v-html -- server-sanitized note HTML, re-sanitized for this sink -->
            <div v-else class="inbox-note-body text-sm text-(--ui-text-toned) break-words mt-0.5" v-html="inboxSanitizeDisplayHtml(entry.note.body)" />
          </div>
        </div>

        <div v-else class="flex items-center gap-2 text-xs text-(--ui-text-muted) pl-1">
          <UIcon :name="activityIcon(entry.activity.eventType)" class="size-3.5 shrink-0 text-(--ui-text-dimmed)" />
          <span class="truncate">{{ entry.activity.message || entry.activity.eventType }}</span>
          <span v-if="entry.activity.actorName" class="text-(--ui-text-dimmed) shrink-0">· {{ entry.activity.actorName }}</span>
          <RelativeTime :value="entry.activity.at" class="text-(--ui-text-dimmed) shrink-0 ml-auto" />
        </div>
      </template>

      <div v-if="hasMore" class="text-center pt-1">
        <UButton label="Load older" size="xs" variant="ghost" color="neutral" @click="loadOlder" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Mention chips inside rendered note bodies (Tiptap's default mention class). */
.inbox-note-body :deep(.mention) {
  color: var(--ui-primary);
  font-weight: 500;
}
.inbox-note-body :deep(p) {
  margin: 0;
}
</style>
