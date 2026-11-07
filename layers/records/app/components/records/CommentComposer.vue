<script setup lang="ts">
// Comment input: textarea + submit button, with Cmd/Ctrl+Enter as the
// keyboard shortcut. `submit` is a function prop so the composer can await
// the API round-trip — the draft clears only on success and errors render
// inline.
const props = defineProps<{
  submit: (body: string) => Promise<unknown>
  placeholder?: string
}>()

const text = ref('')
const sending = ref(false)
const error = ref<string | null>(null)

const canSend = computed(() => text.value.trim().length > 0 && !sending.value)

async function send() {
  if (!canSend.value) return
  const body = text.value.trim()
  sending.value = true
  error.value = null
  try {
    await props.submit(body)
    text.value = ''
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to post comment')
  } finally {
    sending.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="space-y-2">
    <UTextarea
      v-model="text"
      class="w-full"
      :rows="2"
      autoresize
      :maxrows="8"
      :placeholder="placeholder ?? 'Write a comment...'"
      :disabled="sending"
      @keydown="onKeydown"
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
