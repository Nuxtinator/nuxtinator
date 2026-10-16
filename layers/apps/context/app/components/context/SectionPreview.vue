<script setup lang="ts">
import DOMPurify from 'dompurify'
import { renderContextSectionMarkdown } from '../../utils/section-markdown'

const props = defineProps<{ content: string }>()
defineEmits<{ 'select-anchor': [start: number, end: number, quote: string] }>()

const html = computed(() => {
  if (typeof window === 'undefined') return ''
  return DOMPurify.sanitize(renderContextSectionMarkdown(props.content ?? ''))
})

// Content renders after the route has settled, so the browser's own jump to
// the URL's #heading never finds it; scroll once the heading exists.
const route = useRoute()
const body = ref<HTMLElement | null>(null)
watch([html, () => route.hash], async () => {
  if (!route.hash) return
  await nextTick()
  const id = decodeURIComponent(route.hash.slice(1))
  const target = body.value?.querySelector(`[id="${CSS.escape(id)}"]`)
  target?.scrollIntoView({ block: 'start' })
}, { immediate: true })
</script>

<template>
  <div class="p-4">
    <div ref="body" class="markdown-body" v-html="html" />
  </div>
</template>

<style scoped>
.markdown-body {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--ui-text);
}
.markdown-body :deep(p) { margin: 0 0 0.75rem 0; }
.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-weight: 600;
  scroll-margin-top: 1rem;
  margin: 1.25rem 0 0.5rem;
  line-height: 1.3;
}
.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child) { margin-top: 0; }
.markdown-body :deep(h1) { font-size: 1.6rem; }
.markdown-body :deep(h2) { font-size: 1.3rem; }
.markdown-body :deep(h3) { font-size: 1.15rem; }
.markdown-body :deep(h4) { font-size: 1rem; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.5rem;
  margin: 0 0 0.75rem 0;
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
  padding: 0.75rem 1rem;
  overflow-x: auto;
  margin: 0.75rem 0;
}
.markdown-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.875rem;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--ui-border-accented);
  padding-left: 0.75rem;
  color: var(--ui-text-muted);
  margin: 0.75rem 0;
}
.markdown-body :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
}
.markdown-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--ui-border);
  margin: 1rem 0;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0.75rem 0;
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
