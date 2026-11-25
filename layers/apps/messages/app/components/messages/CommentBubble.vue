<script setup lang="ts">
import type { AnchorPayload } from '../../utils/anchor'

interface Comment {
  id: string
  parent_comment_id: string | null
  body_md: string
  anchor: AnchorPayload | null
  anchor_orphaned: boolean
  created_at: string
  edited_at: string | null
  resolved_at: string | null
  author: { id: string, display_name: string, avatar: string }
  reactions: Array<{ emoji: string, count: number, mine: boolean }>
}

const props = defineProps<{
  comment: Comment
  replies: Comment[]
  itemId: string
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { user } = useAuth()
const isAuthor = computed(() => props.comment.author.id === user.value?.id)
const resolved = computed(() => !!props.comment.resolved_at)

const replyOpen = ref(false)
const editing = ref(false)
const editDraft = ref('')
const saving = ref(false)
const errMsg = ref<string | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)

async function postReply(bodyMd: string) {
  await $fetch(`/api/messages/items/${props.itemId}/comments`, {
    method: 'POST',
    body: { body_md: bodyMd, parent_comment_id: props.comment.id }
  })
  replyOpen.value = false
  emit('refresh')
}

function startEdit() {
  editDraft.value = props.comment.body_md
  editing.value = true
  errMsg.value = null
}

function cancelEdit() {
  editing.value = false
  editDraft.value = ''
  errMsg.value = null
}

async function saveEdit(bodyMd: string) {
  saving.value = true
  errMsg.value = null
  try {
    await $fetch(`/api/messages/comments/${props.comment.id}`, {
      method: 'PATCH',
      body: { body_md: bodyMd }
    })
    editing.value = false
    emit('refresh')
  } catch (e) {
    errMsg.value = (e as { statusMessage?: string }).statusMessage ?? 'Failed to save.'
  } finally {
    saving.value = false
  }
}

async function toggleResolved() {
  try {
    await $fetch(`/api/messages/comments/${props.comment.id}/resolve`, {
      method: 'POST',
      body: { resolved: !resolved.value }
    })
    emit('refresh')
  } catch (e) {
    errMsg.value = (e as { statusMessage?: string }).statusMessage ?? 'Failed to update.'
  }
}

function askDelete() {
  errMsg.value = null
  deleteOpen.value = true
}

async function confirmDelete() {
  deleting.value = true
  try {
    await $fetch(`/api/messages/comments/${props.comment.id}`, { method: 'DELETE' })
    deleteOpen.value = false
    emit('refresh')
  } catch (e) {
    errMsg.value = (e as { statusMessage?: string }).statusMessage ?? 'Failed to delete.'
  } finally {
    deleting.value = false
  }
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return d.toLocaleDateString()
}
</script>

<template>
  <article class="bubble" :class="{ resolved }">
    <div class="flex items-start gap-2">
      <UAvatar v-bind="userAvatarProps({ id: comment.author.id, name: comment.author.display_name, image: comment.author.avatar })" size="xs" />
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-semibold">{{ comment.author.display_name }}</span>
          <span class="text-xs text-(--ui-text-muted)">{{ timeLabel(comment.created_at) }}</span>
          <span v-if="comment.edited_at" class="text-xs text-(--ui-text-muted) italic">(edited)</span>
          <span v-if="resolved" class="text-xs text-(--ui-success) italic">resolved</span>
        </div>
        <div
          v-if="comment.anchor && !comment.anchor_orphaned"
          class="anchor-quote"
        >
          "{{ comment.anchor.quote.length > 80 ? comment.anchor.quote.slice(0, 80) + '…' : comment.anchor.quote }}"
        </div>
        <div
          v-if="comment.anchor_orphaned"
          class="orphan-quote"
          title="The original highlighted text no longer exists in this message."
        >
          Orphaned: "{{ comment.anchor?.quote.slice(0, 80) }}"
        </div>

        <template v-if="editing">
          <p v-if="errMsg" class="text-xs text-(--ui-error) mb-1">
            {{ errMsg }}
          </p>
          <MessagesComposer
            :initial="editDraft"
            small
            :enter-to-send="false"
            submit-label="Save"
            placeholder="Edit your comment..."
            @submit="saveEdit"
          />
          <button class="text-xs text-(--ui-text-muted) hover:text-(--ui-text) mt-1" @click="cancelEdit">
            Cancel edit
          </button>
        </template>
        <template v-else>
          <MessagesRenderer :body-md="comment.body_md" />
          <div class="actions">
            <button class="action-btn" @click="replyOpen = !replyOpen">
              {{ replyOpen ? 'Cancel' : 'Reply' }}
            </button>
            <button class="action-btn" :class="{ 'action-resolved': resolved }" @click="toggleResolved">
              {{ resolved ? 'Unresolve' : 'Resolve' }}
            </button>
            <button v-if="isAuthor" class="action-btn" @click="startEdit">
              Edit
            </button>
            <button v-if="isAuthor" class="action-btn action-danger" @click="askDelete">
              Delete
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="replies.length" class="replies">
      <article v-for="r in replies" :key="r.id" class="reply">
        <div class="flex items-start gap-2">
          <UAvatar v-bind="userAvatarProps({ id: r.author.id, name: r.author.display_name, image: r.author.avatar })" size="xs" />
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-semibold">{{ r.author.display_name }}</span>
              <span class="text-xs text-(--ui-text-muted)">{{ timeLabel(r.created_at) }}</span>
            </div>
            <MessagesRenderer :body-md="r.body_md" />
          </div>
        </div>
      </article>
    </div>

    <div v-if="replyOpen && !editing" class="mt-2">
      <MessagesComposer
        small
        placeholder="Reply..."
        submit-label="Reply"
        @submit="postReply"
      />
    </div>

    <UModal v-model:open="deleteOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Delete comment?
          </h2>
          <p class="text-sm">
            This is permanent.
          </p>
          <div class="flex gap-2 justify-end">
            <UButton
              variant="ghost"
              :disabled="deleting"
              @click="deleteOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="confirmDelete"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </article>
</template>

<style scoped>
.bubble {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  padding: 0.75rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.bubble:hover {
  border-color: var(--ui-border-accented);
}
.bubble.resolved {
  opacity: 0.7;
  background: var(--ui-bg-elevated);
}
.anchor-quote {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--ui-text-muted);
  border-left: 2px solid var(--ui-border-accented);
  padding-left: 0.5rem;
  margin: 0.25rem 0;
}
.orphan-quote {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--ui-warning);
  border-left: 2px solid var(--ui-warning);
  padding-left: 0.5rem;
  margin: 0.25rem 0;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}
.action-btn {
  font-size: 0.75rem;
  color: var(--ui-text-muted);
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
}
.action-btn:hover {
  color: var(--ui-text);
  background: var(--ui-bg-elevated);
}
.action-btn.action-danger:hover {
  color: var(--ui-error);
}
.action-btn.action-resolved {
  color: var(--ui-success);
}
.replies {
  margin-top: 0.5rem;
  padding-left: 1.75rem;
  border-left: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
</style>
