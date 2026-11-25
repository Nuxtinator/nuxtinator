<script setup lang="ts">
// Plain-textarea composer. Markdown stays markdown — what you type is what
// gets stored. Display rendering happens elsewhere via MessagesRenderer.
//
// Two modes (chat vs document) controlled by `enterToSend`:
//   true  — Enter sends, Shift+Enter newlines (chat composer)
//   false — Enter newlines, no implicit send (edit / document mode)
//
// `@`-mention autocomplete inserts plain `@DisplayName` text and remembers
// each picked user; at submit time those tokens are rewritten to
// `[@DisplayName](user-uuid)` markdown so the server-side mention extractor
// (server/utils/markdown-mentions.ts) still sees the wire format it expects.

interface OrgUser {
  id: string
  display_name: string
  avatar: string
}

const emit = defineEmits<{
  submit: [bodyMd: string]
}>()

const props = withDefaults(defineProps<{
  placeholder?: string
  submitLabel?: string
  small?: boolean
  initial?: string
  enterToSend?: boolean
  showSubmit?: boolean
  fullHeight?: boolean
}>(), {
  placeholder: 'Write a message...',
  submitLabel: 'Send',
  small: false,
  initial: '',
  enterToSend: true,
  showSubmit: true,
  fullHeight: false
})

const text = ref<string>(props.initial)
const taRef = ref<HTMLTextAreaElement | null>(null)
const submitting = ref(false)

watch(() => props.initial, (next) => {
  text.value = next
})

function autoGrow() {
  const ta = taRef.value
  if (!ta) return
  ta.style.height = 'auto'
  if (props.fullHeight) {
    // Grow to fit content with no cap — outer container handles overflow so
    // the editor and any sibling rail scroll together.
    ta.style.height = `${ta.scrollHeight}px`
    return
  }
  const max = props.small ? 200 : 300
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
}
onMounted(autoGrow)
watch(text, autoGrow)

async function send() {
  const trimmed = text.value.trim()
  if (!trimmed) return
  submitting.value = true
  try {
    emit('submit', serializeMentions(text.value))
    text.value = ''
    mentionCache.clear()
    await nextTick()
    autoGrow()
  } finally {
    submitting.value = false
  }
}

defineExpose({
  focus: () => taRef.value?.focus(),
  submit: () => { send() }
})

// Keyboard wrapping shortcuts: Ctrl/Cmd+B, +I, +K
function wrapSelection(prefix: string, suffix: string = prefix) {
  const ta = taRef.value
  if (!ta) return
  const start = ta.selectionStart
  const end = ta.selectionEnd
  const before = text.value.slice(0, start)
  const selected = text.value.slice(start, end)
  const after = text.value.slice(end)
  text.value = before + prefix + selected + suffix + after
  // Restore cursor: between prefix and suffix when selection was empty,
  // else preserve the highlighted range.
  nextTick(() => {
    if (selected.length === 0) {
      const pos = start + prefix.length
      ta.setSelectionRange(pos, pos)
    } else {
      ta.setSelectionRange(start + prefix.length, end + prefix.length)
    }
    ta.focus()
  })
}

// Link-insert modal state. Opened from the Cmd/Ctrl+K shortcut so we don't
// fall back to a native window.prompt (project rule: toasts + modals only).
// `linkSelection` captures the textarea selection at trigger time so we can
// re-apply it after the modal closes (the textarea loses selection while the
// modal is focused).
const linkOpen = ref(false)
const linkUrl = ref('')
const linkSelection = ref<{ start: number, end: number } | null>(null)
const linkInputRef = ref<HTMLInputElement | null>(null)

function openLinkModal() {
  const ta = taRef.value
  if (!ta) return
  linkSelection.value = { start: ta.selectionStart, end: ta.selectionEnd }
  linkUrl.value = ''
  linkOpen.value = true
  nextTick(() => linkInputRef.value?.focus())
}

function applyLink() {
  const ta = taRef.value
  const sel = linkSelection.value
  const url = linkUrl.value.trim()
  if (!ta || !sel || !url) {
    linkOpen.value = false
    return
  }
  ta.setSelectionRange(sel.start, sel.end)
  wrapSelection('[', `](${url})`)
  linkOpen.value = false
  linkUrl.value = ''
  linkSelection.value = null
}

// Mention autocomplete state
const mentionOpen = ref(false)
const mentionResults = ref<OrgUser[]>([])
const mentionIndex = ref(0)
const mentionAnchor = ref(0) // textarea index of the `@` that started the trigger
// Picked mentions, keyed by display_name. Used at submit time to swap each
// `@DisplayName` token back to `[@DisplayName](uuid)` markdown.
const mentionCache = new Map<string, OrgUser>()
let searchAbort: AbortController | null = null

async function searchUsers(query: string) {
  searchAbort?.abort()
  searchAbort = new AbortController()
  try {
    const res = await $fetch<{ users: OrgUser[] }>('/api/messages/org-users', {
      query: { q: query },
      signal: searchAbort.signal
    })
    mentionResults.value = res.users.slice(0, 8)
    mentionIndex.value = 0
  } catch {
    // ignore
  }
}

// Detect `@token` immediately before the cursor.
function refreshMentionState() {
  const ta = taRef.value
  if (!ta) return
  const cursor = ta.selectionStart
  const upTo = text.value.slice(0, cursor)
  // Match `@<token>` where token follows the @ and contains no whitespace and
  // up to ~30 chars. Triggers if @ is at start or preceded by whitespace.
  const m = /(^|\s)@([\w.\-]{0,30})$/.exec(upTo)
  if (!m) {
    mentionOpen.value = false
    return
  }
  const token = m[2] ?? ''
  mentionAnchor.value = cursor - token.length - 1 // index of the `@`
  mentionOpen.value = true
  searchUsers(token)
}

function pickMention(u: OrgUser) {
  const ta = taRef.value
  if (!ta) return
  // Insert friendly `@DisplayName ` text. The UUID is stored in mentionCache
  // and re-attached as markdown `[@Name](uuid)` at submit time.
  const insertion = `@${u.display_name}`
  const cursor = ta.selectionStart
  const before = text.value.slice(0, mentionAnchor.value)
  const after = text.value.slice(cursor)
  text.value = before + insertion + ' ' + after
  mentionCache.set(u.display_name, u)
  mentionOpen.value = false
  nextTick(() => {
    const pos = before.length + insertion.length + 1
    ta.setSelectionRange(pos, pos)
    ta.focus()
  })
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Convert each tracked `@DisplayName` occurrence in `body` back to
// markdown link form. Boundary mirrors the typeahead trigger: `@` must be at
// start-of-string or preceded by whitespace, and the match must end at a
// word boundary so we don't rewrite e.g. `@alice` inside `@alicent`.
function serializeMentions(body: string): string {
  let out = body
  for (const u of mentionCache.values()) {
    const re = new RegExp(`(^|\\s)@${escapeRegex(u.display_name)}\\b`, 'g')
    out = out.replace(re, (_m, lead) => `${lead}[@${u.display_name}](${u.id})`)
  }
  return out
}

function onInput() {
  refreshMentionState()
}

function onKeydown(event: KeyboardEvent) {
  // Mention popup keymap takes priority when open.
  if (mentionOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      mentionIndex.value = (mentionIndex.value + 1) % Math.max(mentionResults.value.length, 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      mentionIndex.value = (mentionIndex.value - 1 + mentionResults.value.length) % Math.max(mentionResults.value.length, 1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      const u = mentionResults.value[mentionIndex.value]
      if (u) pickMention(u)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      mentionOpen.value = false
      return
    }
  }

  // Wrapping shortcuts
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault()
      wrapSelection('**')
      return
    }
    if (event.key === 'i' || event.key === 'I') {
      event.preventDefault()
      wrapSelection('*')
      return
    }
    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault()
      openLinkModal()
      return
    }
  }

  // Send-on-enter (chat mode only)
  if (props.enterToSend && event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    event.preventDefault()
    send()
  }
}
</script>

<template>
  <div class="composer-wrapper" :class="{ small, 'full-height': fullHeight }">
    <textarea
      ref="taRef"
      v-model="text"
      :placeholder="placeholder"
      class="composer-ta"
      rows="1"
      @input="onInput"
      @keydown="onKeydown"
      @click="refreshMentionState"
    />

    <div v-if="mentionOpen" class="mention-popup">
      <button
        v-for="(u, i) in mentionResults"
        :key="u.id"
        class="mention-item"
        :class="{ 'is-selected': i === mentionIndex }"
        type="button"
        @mousedown.prevent="pickMention(u)"
      >
        <UAvatar v-bind="userAvatarProps({ id: u.id, name: u.display_name, image: u.avatar })" size="2xs" />
        <span class="text-sm">{{ u.display_name }}</span>
      </button>
      <div v-if="mentionResults.length === 0" class="mention-empty">No users</div>
    </div>

    <div v-if="showSubmit" class="composer-footer">
      <UButton size="sm" :loading="submitting" :disabled="!text.trim()" @click="send">
        {{ submitLabel }}
      </UButton>
    </div>

    <UModal v-model:open="linkOpen">
      <template #content>
        <form
          class="p-6 space-y-4"
          @submit.prevent="applyLink"
        >
          <h2 class="text-lg font-semibold">
            Insert link
          </h2>
          <input
            ref="linkInputRef"
            v-model="linkUrl"
            type="url"
            placeholder="https://example.com"
            class="w-full px-3 py-2 rounded-md border border-(--ui-border) bg-(--ui-bg) text-sm"
            @keydown.escape="linkOpen = false"
          >
          <div class="flex gap-2 justify-end">
            <UButton
              type="button"
              variant="ghost"
              @click="linkOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              :disabled="!linkUrl.trim()"
            >
              Insert
            </UButton>
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.composer-wrapper {
  position: relative;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s ease;
}
.composer-wrapper:focus-within {
  border-color: var(--ui-border-accented);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
}
.composer-ta {
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  padding: 12px 16px;
  font-family: inherit;
  font-size: 0.9375rem;
  line-height: 1.55;
  color: var(--ui-text);
  width: 100%;
  min-height: 48px;
  max-height: 300px;
  overflow-y: auto;
}
.composer-wrapper.small .composer-ta {
  padding: 10px 12px;
  min-height: 40px;
  max-height: 200px;
}
.composer-wrapper.full-height .composer-ta {
  /* Grow with content (autoGrow sets height inline) so the surrounding scroll
     container — not the textarea — handles overflow. The min-height keeps
     the editor visually tall even when the body is short. */
  max-height: none;
  min-height: 60vh;
}
.composer-ta::placeholder {
  color: var(--ui-text-muted);
  font-style: italic;
}
.composer-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 6px 12px;
  border-top: 1px solid var(--ui-border);
}
.mention-popup {
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
  z-index: 20;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  box-shadow: 0 6px 14px -2px rgba(0, 0, 0, 0.15);
  padding: 0.25rem;
  min-width: 200px;
  max-width: calc(100% - 24px);
  max-height: 220px;
  overflow-y: auto;
}
.mention-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.375rem 0.5rem;
  border-radius: 4px;
  background: none;
  border: none;
  color: var(--ui-text);
}
.mention-item:hover,
.mention-item.is-selected {
  background: var(--ui-bg-elevated);
}
.mention-empty {
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  color: var(--ui-text-muted);
}
</style>
