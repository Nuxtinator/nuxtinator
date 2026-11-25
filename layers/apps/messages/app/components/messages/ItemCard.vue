<script setup lang="ts">
import type { MessageItem } from '../../composables/useConversationItems'

const props = defineProps<{
  item: MessageItem
}>()

const emit = defineEmits<{
  toggleStar: [itemId: string, starred: boolean]
  toggleReaction: [itemId: string, emoji: string, mine: boolean]
  openComments: [itemId: string]
  tagsChanged: [itemId: string]
}>()

const timeLabel = computed(() => {
  const d = new Date(props.item.created_at)
  const now = Date.now()
  const diffMs = now - d.getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`
  return d.toLocaleDateString()
})

const sizeLabel = computed(() => {
  if (!props.item.size_bytes) return ''
  const n = Number(props.item.size_bytes)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
})

function star() {
  emit('toggleStar', props.item.id, !props.item.starred)
}
function react(emoji: string, mine: boolean) {
  emit('toggleReaction', props.item.id, emoji, mine)
}

const emojiOpen = ref(false)
function onEmojiSelect(emoji: string) {
  const existing = props.item.reactions.find(r => r.emoji === emoji)
  emit('toggleReaction', props.item.id, emoji, existing?.mine ?? false)
  emojiOpen.value = false
}

// Truncation indicator: cap body preview at 700px in CSS, then watch for
// content that overflows so we can show a fade + "Show more" pill.
const bodyRef = ref<HTMLElement | null>(null)
const isTruncated = ref(false)
let ro: ResizeObserver | null = null
function checkOverflow() {
  const el = bodyRef.value
  if (!el) return
  isTruncated.value = el.scrollHeight > el.clientHeight + 1
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && bodyRef.value) {
    ro = new ResizeObserver(checkOverflow)
    ro.observe(bodyRef.value)
  }
  checkOverflow()
})
onBeforeUnmount(() => {
  ro?.disconnect()
})
watch(() => props.item.body_md, () => {
  nextTick(checkOverflow)
})
</script>

<template>
  <article class="item-card group">
    <div class="flex items-start gap-3 mb-2">
      <UAvatar v-bind="userAvatarProps({ id: item.author.id, name: item.author.display_name, image: item.author.avatar })" size="sm" />
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 flex-wrap">
          <span class="text-sm font-semibold">{{ item.author.display_name }}</span>
          <span class="text-xs text-(--ui-text-muted)">{{ timeLabel }}</span>
          <span v-if="item.edited_at" class="text-xs text-(--ui-text-muted) italic">(edited)</span>
        </div>
      </div>
      <button
        class="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:text-(--ui-warning)"
        :class="{ 'opacity-100 text-(--ui-warning)': item.starred }"
        :title="item.starred ? 'Unstar' : 'Star'"
        @click.stop="star"
      >
        <UIcon :name="item.starred ? 'i-lucide-star' : 'i-lucide-star'" class="size-4" :class="{ 'fill-current': item.starred }" />
      </button>
    </div>

    <div class="pl-9">
      <div ref="bodyRef" class="item-body" :class="{ 'is-truncated': isTruncated }">
        <MessagesRenderer
          v-if="item.kind === 'markdown'"
          :body-md="item.body_md"
        />
        <div v-else-if="item.kind === 'image'" class="rounded-lg overflow-hidden border border-(--ui-border) max-w-md">
          <img v-if="item.url" :src="item.url" :alt="item.filename ?? ''" class="w-full h-auto block" loading="lazy">
          <div v-else class="p-4 text-sm text-(--ui-text-muted)">
            {{ item.filename }}
          </div>
        </div>
        <div v-else class="flex items-center gap-2 p-3 border border-(--ui-border) rounded-lg max-w-md">
          <UIcon name="i-lucide-file" class="size-5 text-(--ui-text-muted)" />
          <a v-if="item.url" :href="item.url" target="_blank" rel="noopener" class="text-sm font-medium text-(--ui-primary) hover:underline">
            {{ item.filename }}
          </a>
          <span v-else class="text-sm">{{ item.filename }}</span>
          <span class="text-xs text-(--ui-text-muted) ml-auto">{{ sizeLabel }}</span>
        </div>
        <div v-if="isTruncated" class="truncate-fade">
          <span class="truncate-hint">
            <UIcon name="i-lucide-chevrons-down" class="size-3" />
            Show more
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1 mt-2 flex-wrap" @click.stop>
        <button
          v-for="r in item.reactions"
          :key="r.emoji"
          class="reaction-pill"
          :class="{ mine: r.mine }"
          @click.stop="react(r.emoji, r.mine)"
        >
          <span>{{ r.emoji }}</span>
          <span class="text-xs">{{ r.count }}</span>
        </button>
        <UPopover v-model:open="emojiOpen">
          <button class="reaction-add" aria-label="Add reaction" @click.stop>
            <UIcon name="i-lucide-smile-plus" class="size-3.5" />
          </button>
          <template #content>
            <MessagesEmojiPicker @select="onEmojiSelect" />
          </template>
        </UPopover>
        <button
          class="reaction-add"
          aria-label="Comments"
          @click.stop="emit('openComments', item.id)"
        >
          <UIcon name="i-lucide-message-square" class="size-3.5" />
          <span v-if="item.comment_count" class="text-xs ml-1">{{ item.comment_count }}</span>
        </button>
        <UBadge v-for="tag in item.my_tags" :key="tag" variant="outline" color="neutral" size="sm">
          #{{ tag }}
        </UBadge>
        <MessagesTagPicker
          :item-id="item.id"
          :my-tags="item.my_tags"
          @changed="emit('tagsChanged', item.id)"
        />
      </div>
    </div>
  </article>
</template>

<style scoped>
.item-card {
  padding: 12px 14px;
  border-radius: 8px;
  transition: background-color 0.15s ease;
  cursor: pointer;
}
.item-card:hover {
  background-color: var(--ui-bg-elevated);
}
.item-body {
  /* Cap an item's preview height — click the card to view the full message in
     the modal. */
  max-height: 700px;
  overflow: hidden;
  position: relative;
}
.truncate-fade {
  position: absolute;
  inset: auto 0 0 0;
  height: 96px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 8px;
  background: linear-gradient(to bottom, transparent, var(--ui-bg) 80%);
  pointer-events: none;
}
.item-card:hover .truncate-fade {
  background: linear-gradient(to bottom, transparent, var(--ui-bg-elevated) 80%);
}
.truncate-hint {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--ui-text-muted);
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 9999px;
  padding: 0.125rem 0.625rem;
}
.item-card:hover .truncate-hint {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}
.reaction-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  font-size: 0.875rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-bg);
}
.reaction-pill:hover {
  border-color: var(--ui-border-accented);
}
.reaction-pill.mine {
  background: var(--ui-bg-elevated);
  border-color: var(--ui-primary);
  color: var(--ui-primary);
}
.reaction-add {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  border-radius: 999px;
  color: var(--ui-text-muted);
}
.reaction-add:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}
</style>
