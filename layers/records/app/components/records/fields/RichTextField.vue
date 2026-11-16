<script setup lang="ts">
// Rich text editor for one field. The value is Markdown in and out: headings,
// bulleted, numbered and checkbox lists, quotes, bold/italic/strike/code,
// links, images, people ("@") and links to other records ("#" opens a
// search; a pick becomes a chip that opens that record). It commits when
// focus leaves the field and when it is torn down, and only if the text
// changed. `readonly` shows the same rendering without the toolbar. Clicking
// a link or a record chip opens it, in both modes.
//
// Images are files on the record: a pasted, dropped or picked image uploads
// to `imageUploadUrl` and is stored as `![name](attachment:<file id>)`.
// `images` (the record's files) supplies each one's current link, which is
// what the editor shows. While one uploads, the text shows the local file,
// dimmed, and a line under the text says so. A commit also names the images
// uploaded here that the text no longer shows, so their files can go; once
// an image has been saved in the text, the server keeps the two in step.
import { TaskItem, TaskList } from '@tiptap/extension-list'
import type { Editor } from '@tiptap/vue-3'
import type { EditorCustomHandlers, EditorMentionMenuItem, EditorToolbarItem } from '@nuxt/ui'
import type { RecordsAttachmentValue } from '#records'
import type { RecordsFieldSetting } from '../../../utils/field-kinds'

const props = withDefaults(defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
  readonly?: boolean
  /** The record's files, for the images in the text. */
  images?: RecordsAttachmentValue[]
  /** Where a new image uploads; without it images can't be added. */
  imageUploadUrl?: string
}>(), {
  readonly: false,
  images: () => [],
  imageUploadUrl: undefined
})

const emit = defineEmits<{
  /** `discardImages`: files uploaded here that the text doesn't show. */
  commit: [value: string | null, discardImages?: string[]]
  /** An image was uploaded onto the record; it should be refetched. */
  uploaded: []
}>()

const toast = useToast()
const typePath = useRecordsTypePath()
const { types, ensureTypes } = useRecordsTypes()
const { searchUsers } = useRecordsUsers()

const extensions = [TaskList, TaskItem.configure({ nested: true })]

// --- images: stored by file id, shown by link ---------------------------------

const ATTACHMENT_RE = /\]\(attachment:([0-9a-f-]{36})\)/gi
// Every link seen for a file, so text written under an older link still maps
// back to its file.
const idByUrl = new Map<string, string>()
const urlById = computed(() => new Map(props.images.map(f => [f.id, f.url])))
watch(() => props.images, (files) => {
  for (const file of files) idByUrl.set(file.url, file.id)
}, { immediate: true })

function toEditor(markdown: string): string {
  return markdown.replace(ATTACHMENT_RE, (whole, id: string) => {
    const url = urlById.value.get(id)
    return url ? `](${url})` : whole
  })
}
// An image still uploading points at a local preview, which is never stored.
const PREVIEW_RE = /!\[[^\]]*\]\(blob:[^)]*\)/g
function toStored(markdown: string): string {
  let out = markdown.replace(PREVIEW_RE, '')
  for (const [url, id] of idByUrl) out = out.split(`](${url})`).join(`](attachment:${id})`)
  return out
}

// --- value ------------------------------------------------------------------

const current = computed(() => typeof props.modelValue === 'string' ? props.modelValue : '')
const draft = ref(toEditor(current.value))

const root = ref<HTMLElement | null>(null)
const editorRef = shallowRef<{ editor?: Editor } | null>(null)
const focused = ref(false)

// The editor writes Markdown its own way (bullet marks, line breaks), so
// "changed" is judged against its rendering of the stored value, not the
// stored string.
const serialize = () => toStored(editorRef.value?.editor?.getMarkdown() ?? draft.value).trim()
let baseline = current.value.trim()
function rebase() {
  nextTick(() => {
    baseline = serialize()
  })
}
onMounted(rebase)

watch(current, (value) => {
  if (focused.value || value.trim() === serialize()) return
  draft.value = toEditor(value)
  rebase()
})

// Files uploaded here and not yet saved as part of the text.
const unsaved = new Set<string>()

function commit() {
  if (props.readonly) return
  const next = serialize()
  let discard: string[] = []
  if (uploads.value === 0) {
    discard = [...unsaved].filter(id => !next.includes(`(attachment:${id})`))
    unsaved.clear()
  }
  if (next === baseline && discard.length === 0) return
  baseline = next
  emit('commit', next === '' ? null : next, discard.length > 0 ? discard : undefined)
}

function onFocusOut(event: FocusEvent) {
  if (root.value?.contains(event.relatedTarget as Node | null)) return
  focused.value = false
  commit()
}
onBeforeUnmount(commit)

// --- image upload -----------------------------------------------------------

// Images on their way up, shown as a count under the text.
const uploads = ref(0)
const fileInput = ref<HTMLInputElement | null>(null)

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter(file => recordsIsImage({ mime: file.type }))

// Points the image showing `preview` at its uploaded file, or drops it.
function settlePreview(preview: string, file: RecordsAttachmentValue | null) {
  const editor = editorRef.value?.editor
  if (!editor || editor.isDestroyed) return
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image' || node.attrs.src !== preview) return
    const at = tr.mapping.map(pos)
    if (file) tr.setNodeMarkup(at, undefined, { ...node.attrs, src: file.url, alt: file.name })
    else tr.delete(at, at + node.nodeSize)
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

async function insertImages(files: File[], pos?: number) {
  const editor = editorRef.value?.editor
  if (!editor || !props.imageUploadUrl || files.length === 0) return
  const previews = files.map(file => URL.createObjectURL(file))
  editor.chain().focus().insertContentAt(
    pos ?? editor.state.selection.to,
    files.map((file, i) => ({ type: 'image', attrs: { src: previews[i], alt: file.name || 'image' } }))
  ).run()
  uploads.value += files.length
  try {
    const body = new FormData()
    for (const file of files) body.append('file', file, file.name || 'image.png')
    const res = await $fetch<{ files: RecordsAttachmentValue[] }>(props.imageUploadUrl, { method: 'POST', body })
    const added = res.files.slice(-files.length)
    previews.forEach((preview, i) => {
      const file = added[i] ?? null
      if (file) {
        idByUrl.set(file.url, file.id)
        unsaved.add(file.id)
      }
      settlePreview(preview, file)
    })
    emit('uploaded')
  } catch (err) {
    for (const preview of previews) settlePreview(preview, null)
    toast.add({ title: recordsErrorMessage(err, 'Image upload failed'), color: 'error' })
  } finally {
    uploads.value -= files.length
    for (const preview of previews) URL.revokeObjectURL(preview)
    // Focus may have left while the image was on its way.
    if (!focused.value) commit()
  }
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement
  insertImages(imageFiles(input.files))
  input.value = ''
}

// --- links ------------------------------------------------------------------

const RECORD_PATH_RE = /^\/records\/([^/]+)\/([0-9a-f-]{36})$/i

function openHref(href: string, event: MouseEvent) {
  const record = RECORD_PATH_RE.exec(href)
  const internal = record ? typePath(record[1]!, record[2]!) : href.startsWith('/') && !href.startsWith('//') ? href : null
  const newTab = event.metaKey || event.ctrlKey
  if (internal) {
    navigateTo(internal, newTab ? { open: { target: '_blank' } } : undefined)
  } else if (/^(https?:|mailto:)/i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}

// A record chip's id is "<type key>/<record id>".
function openRecord(ref: string, event: MouseEvent) {
  const [typeKey, id] = ref.split('/')
  if (typeKey && id) openHref(`/records/${typeKey}/${id}`, event)
}

interface ClickedNode {
  type: { name: string }
  attrs: Record<string, unknown>
}

const editorProps = {
  handleClickOn(_view: unknown, _pos: number, node: ClickedNode, _nodePos: number, event: MouseEvent) {
    if (node.type.name !== 'mention' || node.attrs.mentionSuggestionChar !== '#' || typeof node.attrs.id !== 'string') return false
    event.preventDefault()
    openRecord(node.attrs.id, event)
    return true
  },
  handleClick(_view: unknown, _pos: number, event: MouseEvent) {
    const href = (event.target as HTMLElement | null)?.closest('a')?.getAttribute('href')
    if (!href) return false
    event.preventDefault()
    openHref(href, event)
    return true
  },
  handlePaste(_view: unknown, event: ClipboardEvent) {
    const files = imageFiles(event.clipboardData?.files)
    if (files.length === 0 || !props.imageUploadUrl) return false
    event.preventDefault()
    insertImages(files)
    return true
  },
  handleDrop(view: { posAtCoords: (coords: { left: number, top: number }) => { pos: number } | null }, event: DragEvent, _slice: unknown, moved: boolean) {
    const files = moved ? [] : imageFiles(event.dataTransfer?.files)
    if (files.length === 0 || !props.imageUploadUrl) return false
    event.preventDefault()
    insertImages(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
    return true
  }
}

// --- "#" records and "@" people -----------------------------------------------

// A chip's label sits inside `label="…"` in the stored Markdown.
const chipLabel = (name: string) => name.replace(/["[\]]/g, '\'')

// Runs `search` a moment after `term` settles; only the newest run fills `items`.
function useChipSearch(search: (q: string) => Promise<EditorMentionMenuItem[]>) {
  const term = ref('')
  const items = shallowRef<EditorMentionMenuItem[]>([])
  let run = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  async function load(q: string) {
    const mine = ++run
    const found = await search(q).catch(() => [])
    if (mine === run) items.value = found
  }
  watch(term, (q) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => load(q.trim()), 200)
  })
  onMounted(() => {
    if (!props.readonly) load('')
  })
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })
  return { term, items }
}

const recordSearch = useChipSearch(async (q) => {
  await ensureTypes().catch(() => {})
  const found = await Promise.all(types.value.slice(0, 8).map(async (type) => {
    try {
      const res = await $fetch<{ items: Array<{ id: string, name: string }> }>(`/api/records/entries/${type.key}/search`, {
        query: { q, limit: 5 }
      })
      return res.items.map(r => ({
        id: `${type.key}/${r.id}`,
        label: chipLabel(r.name),
        icon: type.icon ?? 'i-lucide-folder',
        description: type.labelSingular
      }))
    } catch {
      return []
    }
  }))
  return found.flat()
})

const peopleSearch = useChipSearch(async q =>
  (await searchUsers(q)).slice(0, 8).map(user => ({
    id: user.id,
    label: chipLabel(user.name),
    avatar: userAvatarProps({ id: user.id, name: user.name, image: user.avatarUrl })
  })))

// --- toolbar ----------------------------------------------------------------

// The "@" and "#" buttons type the character that opens their search.
const typeTrigger = (char: string) => ({
  canExecute: () => true,
  execute: (editor: Editor) => {
    const { $from } = editor.state.selection
    const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset)
    return editor.chain().focus().insertContent(before && before !== ' ' ? ` ${char}` : char)
  },
  isActive: () => false
})
const handlers: EditorCustomHandlers = {
  personMention: typeTrigger('@'),
  recordLink: typeTrigger('#')
}

const tip = (text: string) => ({ 'tooltip': { text }, 'aria-label': text })
const toolbarItems = computed(() => [
  [
    { kind: 'heading', level: 1, icon: 'i-lucide-heading-1', ...tip('Heading 1') },
    { kind: 'heading', level: 2, icon: 'i-lucide-heading-2', ...tip('Heading 2') },
    { kind: 'heading', level: 3, icon: 'i-lucide-heading-3', ...tip('Heading 3') }
  ],
  [
    { kind: 'mark', mark: 'bold', icon: 'i-lucide-bold', ...tip('Bold') },
    { kind: 'mark', mark: 'italic', icon: 'i-lucide-italic', ...tip('Italic') },
    { kind: 'mark', mark: 'strike', icon: 'i-lucide-strikethrough', ...tip('Strikethrough') },
    { kind: 'mark', mark: 'code', icon: 'i-lucide-code', ...tip('Code') }
  ],
  [
    { kind: 'bulletList', icon: 'i-lucide-list', ...tip('Bulleted list') },
    { kind: 'orderedList', icon: 'i-lucide-list-ordered', ...tip('Numbered list') },
    { kind: 'taskList', icon: 'i-lucide-list-checks', ...tip('Checklist') },
    { kind: 'blockquote', icon: 'i-lucide-text-quote', ...tip('Quote') }
  ],
  [
    { slot: 'link' },
    ...(props.imageUploadUrl ? [{ slot: 'image' }] : []),
    { kind: 'personMention', icon: 'i-lucide-at-sign', ...tip('Mention someone (@)') },
    { kind: 'recordLink', icon: 'i-lucide-hash', ...tip('Link a card (#)') }
  ]
] as EditorToolbarItem[][])
</script>

<template>
  <div
    ref="root"
    class="records-rich-text rounded-md"
    :class="readonly ? '' : 'ring ring-(--ui-border-accented) focus-within:ring-2 focus-within:ring-(--ui-primary) bg-(--ui-bg)'"
    @focusin="focused = true"
    @focusout="onFocusOut"
  >
    <UEditor
      ref="editorRef"
      v-slot="{ editor }"
      v-model="draft"
      content-type="markdown"
      :markdown="{ markedOptions: { gfm: true, breaks: true } }"
      :editable="!readonly"
      :extensions="extensions"
      :handlers="handlers"
      :editor-props="editorProps"
      :placeholder="readonly ? undefined : 'Write something. @ mentions someone, # links a card…'"
      :ui="{ base: ['text-sm *:my-2 [&_p]:leading-6 [&_li]:my-0', readonly ? 'sm:px-0' : 'px-3 py-2.5 sm:px-3 min-h-32'] }"
    >
      <template v-if="!readonly">
        <UEditorToolbar
          :editor="editor"
          :items="toolbarItems"
          class="border-b border-(--ui-border) px-1.5 py-1 overflow-x-auto"
        >
          <template #link>
            <RecordsFieldsRichTextLinkPopover :editor="editor" />
          </template>
          <template #image>
            <UTooltip text="Image">
              <UButton
                icon="i-lucide-image"
                color="neutral"
                variant="ghost"
                size="sm"
                :loading="uploads > 0"
                aria-label="Image"
                @click="fileInput?.click()"
              />
            </UTooltip>
          </template>
        </UEditorToolbar>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          multiple
          class="hidden"
          @change="onPick"
        >
        <UEditorMentionMenu
          v-model:search-term="peopleSearch.term.value"
          :editor="editor"
          :items="peopleSearch.items.value"
          char="@"
          plugin-key="personMentionMenu"
          ignore-filter
        />
        <UEditorMentionMenu
          v-model:search-term="recordSearch.term.value"
          :editor="editor"
          :items="recordSearch.items.value"
          char="#"
          plugin-key="recordLinkMenu"
          ignore-filter
        />
      </template>
    </UEditor>
    <div
      v-if="uploads > 0"
      role="status"
      class="flex items-center gap-1.5 border-t border-(--ui-border) px-3 py-1.5 text-xs text-(--ui-text-muted)"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-3.5 animate-spin"
      />
      {{ uploads === 1 ? 'Uploading image…' : `Uploading ${uploads} images…` }}
    </div>
  </div>
</template>

<style scoped>
.records-rich-text :deep(ul[data-type='taskList']) {
  list-style: none;
  padding-inline-start: 0;
}
.records-rich-text :deep(ul[data-type='taskList'] li) {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding-inline-start: 0;
}
.records-rich-text :deep(ul[data-type='taskList'] li > label) {
  flex-shrink: 0;
  margin-top: 0.35rem;
}
.records-rich-text :deep(ul[data-type='taskList'] li > div) {
  flex: 1;
  min-width: 0;
}
.records-rich-text :deep(ul[data-type='taskList'] li > div > p) {
  margin: 0;
}
.records-rich-text :deep(ul[data-type='taskList'] li[data-checked='true'] > div > p) {
  color: var(--ui-text-dimmed);
  text-decoration: line-through;
}
.records-rich-text :deep(ul[data-type='taskList'] input[type='checkbox']) {
  accent-color: var(--ui-primary);
}
.records-rich-text :deep(a),
.records-rich-text :deep(.mention[data-mention-suggestion-char='#']) {
  cursor: pointer;
}
.records-rich-text :deep(img) {
  max-height: 28rem;
}
.records-rich-text :deep(img[src^='blob:']) {
  animation: records-rich-text-uploading 1.4s ease-in-out infinite;
}
@keyframes records-rich-text-uploading {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 0.25; }
}
</style>
