<script setup lang="ts">
// Comment input: the rich text editor as a comment box (lists, links, "@"
// people, "#" cards and, given `imageUploadUrl`, images) + submit button, with
// Cmd/Ctrl+Enter as the keyboard shortcut. `submit` is a function prop so the
// composer can await the API round-trip — the draft clears only on success
// and errors render inline.
const props = defineProps<{
  submit: (body: string) => Promise<unknown>
  placeholder?: string
  /** Where a pasted, dropped or picked image uploads. */
  imageUploadUrl?: string
}>()

interface CommentBox {
  value: () => string
  empty: boolean
  uploading: boolean
}

const box = ref<CommentBox | null>(null)
// Bumped after a post, so a fresh, empty box replaces the sent one.
const boxKey = ref(0)
const sending = ref(false)
const error = ref<string | null>(null)

const canSend = computed(() => !!box.value && !box.value.empty && !box.value.uploading && !sending.value)

async function send() {
  if (!canSend.value) return
  const body = box.value!.value()
  if (!body) return
  sending.value = true
  error.value = null
  try {
    await props.submit(body)
    boxKey.value++
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to post comment')
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="space-y-2">
    <RecordsFieldsRichTextField
      ref="box"
      :key="boxKey"
      model-value=""
      composer
      :placeholder="placeholder ?? 'Write a comment… (/ for lists and more)'"
      :image-upload-url="imageUploadUrl"
      @submit="send"
    />
    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />
    <div class="flex justify-end">
      <UButton
        size="sm"
        icon="i-lucide-send"
        :loading="sending"
        :disabled="!canSend"
        @click="send"
      >
        Comment
      </UButton>
    </div>
  </div>
</template>
