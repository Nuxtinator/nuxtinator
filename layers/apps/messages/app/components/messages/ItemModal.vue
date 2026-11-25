<script setup lang="ts">
// Full-screen modal for an item. Doc + comments rail share a single scroll
// container so they move together. Each comment bubble is positioned
// absolutely at the y-coord of its anchor's first line (Google-Docs style).
// Orphans + unanchored comments pin at the top of the rail. The composer
// for a pending anchor appears as a bubble at the selection's y.

import type { MessageItem } from '../../composables/useConversationItems'
import type { AnchorPayload } from '../../utils/anchor'
import { useAnchorRail } from '../../composables/useAnchorRail'

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
  item: MessageItem | null
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  saved: []
  // Fired after a comment is posted (anchored or floating). The parent uses
  // this to refresh its item list so the comment-count badge updates without
  // waiting for the 30s poll.
  commented: []
}>()

const { user } = useAuth()

const editing = ref(false)
const draft = ref<string>('')
const saving = ref(false)
const saveError = ref<string | null>(null)
const pendingAnchor = ref<AnchorPayload | null>(null)

const comments = ref<Comment[]>([])
const composerBubbleRef = ref<{ focus: () => void } | null>(null)
const editorRef = ref<{ submit: () => void } | null>(null)
const rendererRef = ref<{ getRootEl: () => HTMLElement | null } | null>(null)
const docContentRef = ref<HTMLElement | null>(null)
const railRef = ref<HTMLElement | null>(null)

const isAuthor = computed(() => props.item?.author.id === user.value?.id)
const canEdit = computed(() => isAuthor.value && props.item?.kind === 'markdown')

const topLevelComments = computed(() => comments.value.filter(c => !c.parent_comment_id))
const repliesByParent = computed(() => {
  const m = new Map<string, Comment[]>()
  for (const c of comments.value) {
    if (c.parent_comment_id) {
      const arr = m.get(c.parent_comment_id) ?? []
      arr.push(c)
      m.set(c.parent_comment_id, arr)
    }
  }
  return m
})

const showResolved = ref(false)
const activeTopLevel = computed(() =>
  showResolved.value
    ? topLevelComments.value
    : topLevelComments.value.filter(c => !c.resolved_at)
)
const resolvedCount = computed(() => topLevelComments.value.filter(c => c.resolved_at).length)
const anchoredComments = computed(() =>
  activeTopLevel.value
    .filter(c => c.anchor && !c.anchor_orphaned)
    .sort((a, b) => (a.anchor!.start - b.anchor!.start))
)
const floatingComments = computed(() => activeTopLevel.value.filter(c => !c.anchor || c.anchor_orphaned))

const { positions, pendingY, recompute } = useAnchorRail({
  rendererRef,
  docContentRef,
  railRef,
  anchoredComments,
  floatingComments,
  pendingAnchor
})

watch(() => [open.value, props.item?.id], () => {
  editing.value = false
  draft.value = ''
  saveError.value = null
  pendingAnchor.value = null
  comments.value = []
  if (open.value && props.item) loadComments()
})

async function loadComments() {
  if (!props.item) return
  try {
    const res = await $fetch<{ comments: Comment[] }>(`/api/messages/items/${props.item.id}/comments`)
    comments.value = res.comments
  } catch (e) {
    console.error('Failed to load comments:', e)
  }
}

function onSelectAnchor(payload: AnchorPayload) {
  pendingAnchor.value = payload
  // Wait two ticks: the rail composable schedules a recompute on the first;
  // the second lets the composer bubble mount before we focus its textarea.
  nextTick(() => nextTick(() => composerBubbleRef.value?.focus()))
}

function clearPendingAnchor() {
  pendingAnchor.value = null
}

async function postAnchored(bodyMd: string) {
  if (!props.item) return
  const anchor = pendingAnchor.value
  if (!anchor) return
  await $fetch(`/api/messages/items/${props.item.id}/comments`, {
    method: 'POST',
    body: { body_md: bodyMd, anchor }
  })
  clearPendingAnchor()
  await loadComments()
  emit('commented')
}

async function postFloating(bodyMd: string) {
  if (!props.item) return
  await $fetch(`/api/messages/items/${props.item.id}/comments`, {
    method: 'POST',
    body: { body_md: bodyMd }
  })
  await loadComments()
  emit('commented')
}

function startEdit() {
  if (!props.item) return
  draft.value = props.item.body_md ?? ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
}

async function save(bodyMd: string) {
  if (!props.item) return
  saving.value = true
  saveError.value = null
  try {
    await $fetch(`/api/messages/items/${props.item.id}`, {
      method: 'PATCH',
      body: { body_md: bodyMd }
    })
    editing.value = false
    emit('saved')
    // Reload comments since anchors may have shifted/orphaned.
    await loadComments()
  } catch (e) {
    saveError.value = (e as { statusMessage?: string }).statusMessage ?? 'Failed to save.'
  } finally {
    saving.value = false
  }
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleString()
}

// Trigger a position recompute when the item body changes (e.g. after edit
// or after the renderer re-mounts because edit mode toggled).
watch([() => props.item?.body_md, editing], () => {
  nextTick(recompute)
})
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{
      content: 'w-full h-screen max-w-7xl sm:max-w-7xl'
    }"
  >
    <template #content>
      <div v-if="item" class="flex flex-col h-full bg-(--ui-bg)">
        <header class="flex items-center justify-between px-5 py-3 border-b border-(--ui-border)">
          <div class="flex items-center gap-3 min-w-0">
            <UAvatar v-bind="userAvatarProps({ id: item.author.id, name: item.author.display_name, image: item.author.avatar })" size="sm" />
            <div class="min-w-0">
              <div class="text-sm font-semibold truncate">
                {{ item.author.display_name }}
              </div>
              <div class="text-xs text-(--ui-text-muted)">
                {{ timeLabel(item.created_at) }}
                <span v-if="item.edited_at" class="italic"> · edited</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <UButton
              v-if="canEdit && !editing"
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              @click="startEdit"
            >
              Edit
            </UButton>
            <UButton
              v-if="editing"
              icon="i-lucide-check"
              color="primary"
              size="sm"
              :loading="saving"
              @click="editorRef?.submit()"
            >
              Save
            </UButton>
            <UButton
              v-if="editing"
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              size="sm"
              :disabled="saving"
              @click="cancelEdit"
            >
              Cancel
            </UButton>
            <UButton
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Close"
              @click="open = false"
            />
          </div>
        </header>

        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="max-w-7xl mx-auto px-6 py-6 flex gap-6 items-start">
            <div ref="docContentRef" class="flex-1 min-w-0 max-w-3xl relative">
              <p v-if="saveError" class="text-xs text-(--ui-error) mb-2">
                {{ saveError }}
              </p>
              <template v-if="editing">
                <MessagesComposer
                  ref="editorRef"
                  :initial="draft"
                  :enter-to-send="false"
                  :show-submit="false"
                  placeholder="Edit your message..."
                  full-height
                  @submit="save"
                />
              </template>
              <template v-else>
                <MessagesRenderer
                  v-if="item.kind === 'markdown'"
                  ref="rendererRef"
                  :body-md="item.body_md"
                  enable-anchor-comment
                  @select-anchor="onSelectAnchor"
                />
                <div v-else-if="item.kind === 'image'" class="rounded-lg overflow-hidden border border-(--ui-border)">
                  <img v-if="item.url" :src="item.url" :alt="item.filename ?? ''" class="w-full h-auto block">
                  <div v-else class="p-4 text-sm text-(--ui-text-muted)">{{ item.filename }}</div>
                </div>
                <div v-else class="flex items-center gap-2 p-3 border border-(--ui-border) rounded-lg max-w-md">
                  <UIcon name="i-lucide-file" class="size-5 text-(--ui-text-muted)" />
                  <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="text-sm font-medium text-(--ui-primary) hover:underline">
                    {{ item.filename }}
                  </a>
                  <span v-else class="text-sm">{{ item.filename }}</span>
                </div>
              </template>
            </div>

            <aside ref="railRef" class="w-80 shrink-0 relative">
              <!-- Resolved disclosure -->
              <div v-if="resolvedCount > 0" class="mb-2 text-xs">
                <button
                  class="text-(--ui-text-muted) hover:text-(--ui-text)"
                  @click="showResolved = !showResolved"
                >
                  {{ showResolved ? 'Hide' : 'Show' }} {{ resolvedCount }} resolved
                </button>
              </div>

              <!-- All bubbles (floating + anchored) are absolutely positioned and
                   participate in the stacking algorithm so they don't overlap -->
              <MessagesCommentBubble
                v-for="c in floatingComments"
                :key="c.id"
                :data-bubble-id="c.id"
                :comment="c"
                :replies="repliesByParent.get(c.id) ?? []"
                :item-id="item.id"
                class="absolute left-0 right-0"
                :style="{ position: 'absolute', top: `${positions.get(c.id) ?? 0}px`, left: 0, right: 0 }"
                @refresh="loadComments"
              />
              <MessagesCommentBubble
                v-for="c in anchoredComments"
                :key="c.id"
                :data-bubble-id="c.id"
                :comment="c"
                :replies="repliesByParent.get(c.id) ?? []"
                :item-id="item.id"
                class="absolute left-0 right-0"
                :style="{ position: 'absolute', top: `${positions.get(c.id) ?? 0}px`, left: 0, right: 0 }"
                @refresh="loadComments"
              />

              <!-- Pending-anchor composer bubble -->
              <div
                v-if="pendingAnchor && pendingY != null"
                data-bubble-id="pending"
                class="absolute left-0 right-0 composer-bubble"
                :style="{ top: `${pendingY}px` }"
              >
                <div class="anchor-pill">
                  <span class="font-semibold text-(--ui-primary)">Comment on:</span>
                  <span class="italic text-(--ui-text-muted) ml-1">
                    "{{ pendingAnchor.quote.length > 60 ? pendingAnchor.quote.slice(0, 60) + '…' : pendingAnchor.quote }}"
                  </span>
                  <button class="ml-auto text-(--ui-text-muted) hover:text-(--ui-text)" @click="clearPendingAnchor">
                    <UIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </div>
                <MessagesComposer
                  ref="composerBubbleRef"
                  small
                  placeholder="Comment on the highlighted text..."
                  submit-label="Comment"
                  @submit="postAnchored"
                />
              </div>

              <!-- Catch-all composer when the rail is empty. Lets users post
                   the first comment without having to make a text selection
                   first — important on touch devices and for non-markdown
                   items where selection-anchoring isn't possible. The hint
                   sits above the composer; selecting text still works and
                   morphs into the anchored-composer flow above. -->
              <div v-if="!editing && floatingComments.length === 0 && anchoredComments.length === 0 && !pendingAnchor" class="space-y-2">
                <p class="text-xs text-(--ui-text-muted)">
                  Highlight text on the left to comment on it, or just leave a general comment below:
                </p>
                <MessagesComposer
                  small
                  placeholder="Add a comment..."
                  submit-label="Comment"
                  @submit="postFloating"
                />
              </div>
            </aside>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.anchor-pill {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.625rem;
  margin-bottom: 0.375rem;
  border: 1px solid var(--ui-primary);
  background: var(--ui-bg-elevated);
  border-radius: 6px;
  font-size: 0.75rem;
}
.composer-bubble {
  background: var(--ui-bg);
  border: 1px solid var(--ui-primary);
  border-radius: 8px;
  padding: 0.5rem;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
}
</style>
