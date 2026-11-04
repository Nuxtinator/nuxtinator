<script setup lang="ts">
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ content: string }>()

const html = computed(() => {
  if (typeof window === 'undefined') return ''
  const raw = marked.parse(props.content ?? '', { async: false }) as string
  return DOMPurify.sanitize(raw)
})
</script>

<template>
  <div class="markdown-body" v-html="html" />
</template>

<style scoped>
.markdown-body {
  font-size: 0.875rem;
  line-height: 1.55;
  color: var(--ui-text);
}
.markdown-body :deep(p) { margin: 0 0 0.5rem 0; }
.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-weight: 600;
  margin: 0.75rem 0 0.375rem;
  line-height: 1.3;
}
.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child) { margin-top: 0; }
.markdown-body :deep(h1) { font-size: 1.25rem; }
.markdown-body :deep(h2) { font-size: 1.125rem; }
.markdown-body :deep(h3) { font-size: 1rem; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.25rem;
  margin: 0 0 0.5rem 0;
}
.markdown-body :deep(ul) { list-style-type: disc; }
.markdown-body :deep(ol) { list-style-type: decimal; }
.markdown-body :deep(ul ul) { list-style-type: circle; }
.markdown-body :deep(li) { margin: 0.125rem 0; }
.markdown-body :deep(li > p) { margin: 0; }
.markdown-body :deep(li > ul),
.markdown-body :deep(li > ol) { margin-bottom: 0; }
.markdown-body :deep(strong) { font-weight: 600; }
.markdown-body :deep(code) {
  background: var(--ui-bg-elevated);
  padding: 0.1em 0.3em;
  border-radius: 4px;
  font-size: 0.875em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.markdown-body :deep(pre) {
  background: var(--ui-bg-elevated);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  margin: 0.5rem 0;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.8125rem;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--ui-border-accented);
  padding-left: 0.75rem;
  color: var(--ui-text-muted);
  margin: 0.5rem 0;
}
.markdown-body :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
}
.markdown-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--ui-border);
  margin: 0.75rem 0;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0.5rem 0;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--ui-border);
  padding: 0.25rem 0.5rem;
  text-align: left;
  vertical-align: top;
}
.markdown-body :deep(th) {
  font-weight: 600;
  background: var(--ui-bg-elevated);
}
.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
</style>
