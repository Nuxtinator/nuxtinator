<script setup lang="ts">
// One comment: author name, relative time, edited marker, plain-text body
// with preserved line breaks (no markdown/mentions), and an edit/delete menu
// on the caller's own comments. Editing happens inline; `save` and `remove`
// report the intent upward — the parent owns the API round-trip, and the
// body prop self-corrects if the server rejects the edit.
import type { CrmCommentItem } from '../../composables/useCrmTimeline'

const props = defineProps<{
  comment: CrmCommentItem
  /** Whether the comment belongs to the current user (shows the menu). */
  own: boolean
}>()

const emit = defineEmits<{
  save: [body: string]
  remove: []
}>()

const initials = computed(() =>
  props.comment.authorName
    .split(/\s+/)
    .map(part => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
)

const editing = ref(false)
const draft = ref('')

function startEdit() {
  draft.value = props.comment.body
  editing.value = true
}

function saveEdit() {
  const body = draft.value.trim()
  if (!body || body === props.comment.body) {
    editing.value = false
    return
  }
  editing.value = false
  emit('save', body)
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    saveEdit()
  } else if (e.key === 'Escape') {
    editing.value = false
  }
}

const menuItems = computed(() => [[
  { label: 'Edit', icon: 'i-lucide-pencil', onSelect: startEdit },
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => emit('remove') }
]])
</script>

<template>
  <div class="flex gap-3 px-4 py-3">
    <UAvatar
      :text="initials"
      size="sm"
      class="shrink-0 mt-0.5"
    />
    <div class="min-w-0 flex-1 space-y-1">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium truncate">{{ comment.authorName }}</span>
        <span class="text-xs text-(--ui-text-muted) whitespace-nowrap">{{ crmRelativeTime(comment.createdAt) }}</span>
        <span
          v-if="comment.viaClient"
          class="text-xs text-(--ui-text-muted) whitespace-nowrap"
        >via {{ comment.viaClient }}</span>
        <span
          v-if="comment.editedAt"
          class="text-xs text-(--ui-text-muted)"
        >(edited)</span>
        <UDropdownMenu
          v-if="own && !editing"
          :items="menuItems"
          class="ms-auto"
        >
          <UButton
            icon="i-lucide-ellipsis"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Comment actions"
          />
        </UDropdownMenu>
      </div>

      <template v-if="editing">
        <UTextarea
          v-model="draft"
          class="w-full"
          :rows="2"
          autoresize
          autofocus
          @keydown="onEditKeydown"
        />
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            @click="editing = false"
          >
            Cancel
          </UButton>
          <UButton
            size="xs"
            :disabled="!draft.trim()"
            @click="saveEdit"
          >
            Save
          </UButton>
        </div>
      </template>
      <p
        v-else
        class="text-sm whitespace-pre-wrap break-words"
      >{{ comment.body }}</p>
    </div>
  </div>
</template>
