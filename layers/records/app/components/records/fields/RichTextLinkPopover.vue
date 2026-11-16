<script setup lang="ts">
// Toolbar button for links: a popover with the URL of the link under the
// cursor (or an empty box for a new one), Apply and Remove. The popover
// stays inside the editor's own element, so using it doesn't count as
// leaving the field.
import type { Editor } from '@tiptap/vue-3'

const props = defineProps<{
  editor: Editor
}>()

const open = ref(false)
const url = ref('')

const active = computed(() => props.editor.isActive('link'))

watch(open, (isOpen) => {
  if (isOpen) url.value = props.editor.getAttributes('link').href ?? ''
})

// A bare domain gets https://; paths and other schemes are kept.
function normalize(raw: string): string {
  const value = raw.trim()
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('#')) return value
  return `https://${value}`
}

function apply() {
  const href = normalize(url.value)
  if (!href) return remove()
  const chain = props.editor.chain().focus()
  if (props.editor.state.selection.empty && !active.value) {
    chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else {
    chain.extendMarkRange('link').setLink({ href }).run()
  }
  open.value = false
}

function remove() {
  props.editor.chain().focus().extendMarkRange('link').unsetLink().run()
  open.value = false
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :portal="false"
  >
    <UTooltip text="Link">
      <UButton
        icon="i-lucide-link"
        color="neutral"
        variant="ghost"
        active-color="primary"
        active-variant="soft"
        size="sm"
        :active="active"
        aria-label="Link"
      />
    </UTooltip>
    <template #content>
      <form
        class="flex items-center gap-1 p-1.5"
        @submit.prevent="apply"
      >
        <UInput
          v-model="url"
          placeholder="Paste a link"
          size="sm"
          class="w-64"
          autofocus
        />
        <UButton
          type="submit"
          icon="i-lucide-check"
          size="sm"
          aria-label="Apply link"
        />
        <UButton
          v-if="active"
          icon="i-lucide-unlink"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Remove link"
          @click="remove"
        />
      </form>
    </template>
  </UPopover>
</template>
