<script setup lang="ts">
// Sanitized Markdown for bot replies in the read-only log.
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ text: string }>()

const html = computed(() => {
  const raw = marked.parse(props.text || '', { async: false, breaks: true, gfm: true }) as string
  return DOMPurify.sanitize(raw, { ALLOWED_ATTR: ['href', 'title'], FORBID_TAGS: ['img', 'style'] })
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify above -->
  <div class="helpinator-md" v-html="html" />
</template>

<style scoped>
.helpinator-md :deep(p) { margin: 0 0 0.4rem; }
.helpinator-md :deep(p:last-child) { margin-bottom: 0; }
.helpinator-md :deep(ul), .helpinator-md :deep(ol) { margin: 0.25rem 0; padding-left: 1.25rem; list-style: revert; }
.helpinator-md :deep(a) { text-decoration: underline; }
</style>
