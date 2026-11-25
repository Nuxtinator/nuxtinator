<script setup lang="ts">
// One comment: author name, relative time, edited marker, the body as
// formatted rich text, and an edit/delete menu on the caller's own comments.
// Editing happens inline in the same editor as a comment box; `save` and
// `remove` report the intent upward — the parent owns the API round-trip,
// and the body prop self-corrects if the server rejects the edit.
import type { RecordsCommentItem } from '../../composables/useRecordsTimeline'

const props = defineProps<{
  comment: RecordsCommentItem
  /** Whether the comment belongs to the current user (shows the menu). */
  own: boolean
  /** Where an image added while editing uploads. */
  imageUploadUrl?: string
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

interface CommentBox {
  value: () => string
  changed: () => boolean
  empty: boolean
  uploading: boolean
}

const editing = ref(false)
const box = ref<CommentBox | null>(null)
const canSave = computed(() => !!box.value && !box.value.empty && !box.value.uploading)

function startEdit() {
  editing.value = true
}

function saveEdit() {
  if (!canSave.value) return
  const body = box.value!.value()
  if (!body || !box.value!.changed()) {
    editing.value = false
    return
  }
  editing.value = false
  emit('save', body)
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
        <RelativeTime :value="comment.createdAt" class="text-xs text-(--ui-text-muted)" />
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
        <RecordsFieldsRichTextField
          ref="box"
          :model-value="comment.body"
          :images="comment.images"
          :image-upload-url="imageUploadUrl"
          composer
          autofocus
          @submit="saveEdit"
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
            :disabled="!canSave"
            @click="saveEdit"
          >
            Save
          </UButton>
        </div>
      </template>
      <RecordsFieldsRichTextField
        v-else
        :model-value="comment.body"
        :images="comment.images"
        readonly
        class="break-words"
      />
    </div>
  </div>
</template>
