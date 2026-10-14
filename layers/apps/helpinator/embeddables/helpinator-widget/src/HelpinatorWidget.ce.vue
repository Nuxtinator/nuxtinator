<script setup>
// <helpinator-widget> — floating help chat. Fetches its config from the host,
// restores the visitor's conversation (server transcript wins over the local
// cache), streams replies, and offers "still need help?" when the inbox is
// available.
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { createApi } from './api.js'
import { clearState, loadState, saveState } from './storage.js'

const props = defineProps({
  host: { type: String, default: '' },
  widgetId: { type: String, default: '' },
  // Start open (e.g. a dedicated help page).
  open: { type: [Boolean, String], default: false }
})

const api = computed(() => createApi(props.host || window.location.origin, props.widgetId))

const config = ref(null)
const isOpen = ref(props.open === true || props.open === '' || props.open === 'true')
const messages = ref([]) // { id, role, content, pending? }
const token = ref(null)
const visitorEmail = ref(null)
const handedOff = ref(false)
const input = ref('')
const sending = ref(false)
const status = ref('')
const error = ref('')
const panel = ref(null) // 'handoff' | null
const emailDraft = ref('')
const formBusy = ref(false)
const formError = ref('')
const listEl = ref(null)
const inputEl = ref(null)
const emailEl = ref(null)

const appearance = computed(() => config.value?.appearance ?? {})
const rootStyle = computed(() => ({ '--hp-default-primary': appearance.value.primary_color || '#2563eb' }))
const positionClass = computed(() => appearance.value.position === 'bottom-left' ? 'hp-left' : 'hp-right')
const hasUserMessage = computed(() => messages.value.some(m => m.role === 'user' && !m.pending))
// Suggested questions only make sense before the conversation starts.
const starters = computed(() => messages.value.length ? [] : (config.value?.starterQuestions ?? []))

marked.setOptions({ breaks: true, gfm: true })

// Links always open outside the embedding page's flow. Set by a sanitizer
// hook on the parsed node, never by editing the sanitized string afterwards
// (string surgery on DOMPurify output can reopen mutation-XSS holes). This
// bundle carries its own DOMPurify, so the hook only affects the widget.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
})

function renderMarkdown(text) {
  const html = marked.parse(text || '', { async: false })
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title']
  })
}

function persist() {
  saveState(props.widgetId, {
    token: token.value,
    messages: messages.value.filter(m => !m.pending).slice(-100),
    visitorEmail: visitorEmail.value,
    handedOff: handedOff.value,
    open: isOpen.value
  })
}

function resetConversation() {
  token.value = null
  messages.value = []
  visitorEmail.value = null
  handedOff.value = false
  panel.value = null
  error.value = ''
  clearState(props.widgetId)
  persist()
}

async function scrollToEnd() {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

onMounted(async () => {
  if (!props.widgetId) return
  const cached = loadState(props.widgetId)
  if (cached.token) token.value = cached.token
  if (Array.isArray(cached.messages)) messages.value = cached.messages
  visitorEmail.value = cached.visitorEmail ?? null
  handedOff.value = Boolean(cached.handedOff)
  if (cached.open) isOpen.value = true

  try {
    config.value = await api.value.config()
  } catch {
    config.value = null // unknown widget / origin not allowed: render nothing
    return
  }

  // The server transcript is authoritative.
  if (token.value) {
    try {
      const conv = await api.value.conversation(token.value)
      if (conv.conversationId === null) {
        resetConversation() // unknown or ended session: start fresh
      } else {
        messages.value = conv.messages
        visitorEmail.value = conv.visitorEmail
        handedOff.value = conv.handedOff
        persist()
      }
    } catch (err) {
      if (err.status === 401) resetConversation()
    }
  }
  scrollToEnd()
})

watch(isOpen, (open) => {
  persist()
  if (open) {
    scrollToEnd()
    nextTick(() => inputEl.value?.focus())
  } else {
    // Closing the widget dismisses any open handoff form.
    panel.value = null
    formError.value = ''
  }
})

function ask(question) {
  input.value = question
  send()
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  error.value = ''
  status.value = ''
  sending.value = true
  input.value = ''
  const userMsg = reactive({ id: `local-${Date.now()}`, role: 'user', content: text, pending: true })
  const botMsg = reactive({ id: `local-${Date.now()}-a`, role: 'assistant', content: '', pending: true })
  messages.value.push(userMsg, botMsg)
  scrollToEnd()

  try {
    await api.value.send(token.value, text, window.location.href, (name, data) => {
      if (name === 'session') {
        if (data.reset) {
          // Old conversation ended server-side: keep only this turn.
          messages.value = [userMsg, botMsg]
          visitorEmail.value = null
          handedOff.value = false
        }
        token.value = data.token
      } else if (name === 'status') {
        status.value = data.text
      } else if (name === 'delta') {
        status.value = ''
        botMsg.content += data.text
        scrollToEnd()
      } else if (name === 'discard') {
        botMsg.content = ''
      } else if (name === 'done') {
        if (data.token) token.value = data.token
        Object.assign(userMsg, data.userMessage, { pending: false })
        Object.assign(botMsg, data.assistantMessage, { pending: false })
      } else if (name === 'error') {
        throw Object.assign(new Error(data.message || 'Something went wrong — please try again.'), { status: data.statusCode })
      }
    })
    if (botMsg.pending) throw new Error('The reply was interrupted — please try again.')
  } catch (err) {
    messages.value = messages.value.filter(m => m !== botMsg && m !== userMsg)
    input.value = text
    error.value = err.message || 'Something went wrong — please try again.'
  } finally {
    sending.value = false
    status.value = ''
    persist()
    scrollToEnd()
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

// The form replaces the composer while open, so move focus with it.
watch(panel, (val) => {
  nextTick(() => (val ? emailEl.value : inputEl.value)?.focus())
})

function openPanel(kind) {
  panel.value = panel.value === kind ? null : kind
  emailDraft.value = visitorEmail.value || ''
  formError.value = ''
}

async function handoff() {
  formBusy.value = true
  formError.value = ''
  try {
    const email = emailDraft.value.trim()
    await api.value.handoff(token.value, email)
    visitorEmail.value = email.toLowerCase()
    handedOff.value = true
    panel.value = null
    persist()
    scrollToEnd()
  } catch (err) {
    formError.value = err.message
  } finally {
    formBusy.value = false
  }
}
</script>

<template>
  <div v-if="config" class="hp-root" :class="positionClass" :style="rootStyle">
    <section
      v-if="isOpen"
      class="hp-panel"
      part="panel"
      role="dialog"
      :aria-label="appearance.title"
    >
      <header class="hp-header" part="header">
        <div class="hp-heading">
          <span class="hp-title">{{ appearance.title }}</span>
          <span class="hp-subtitle">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
            AI assistant
          </span>
        </div>
        <button
          v-if="hasUserMessage"
          class="hp-icon-btn"
          type="button"
          title="Start a new conversation"
          aria-label="Start a new conversation"
          @click="resetConversation"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button class="hp-icon-btn" type="button" aria-label="Close help" @click="isOpen = false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <div v-if="!config.aiAvailable" class="hp-unavailable">
        The help assistant is unavailable right now. Please try again later.
      </div>

      <template v-else>
        <div ref="listEl" class="hp-messages" aria-live="polite">
          <div class="hp-msg hp-bot" part="message bot-message">
            <span class="hp-sender" part="sender">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
              AI assistant
            </span>
            <div class="hp-bubble" v-html="renderMarkdown(appearance.greeting)" />
          </div>
          <div v-if="starters.length" class="hp-starters" part="starters">
            <button
              v-for="q in starters"
              :key="q"
              type="button"
              class="hp-starter"
              part="starter"
              :disabled="sending"
              @click="ask(q)"
            >
              {{ q }}
            </button>
          </div>
          <div
            v-for="m in messages"
            :key="m.id"
            class="hp-msg"
            :class="m.role === 'user' ? 'hp-user' : 'hp-bot'"
            :part="m.role === 'user' ? 'message user-message' : 'message bot-message'"
          >
            <span v-if="m.role !== 'user'" class="hp-sender" part="sender">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></svg>
              AI assistant
            </span>
            <div v-if="m.role === 'user'" class="hp-bubble">{{ m.content }}</div>
            <div v-else-if="m.content" class="hp-bubble" v-html="renderMarkdown(m.content)" />
            <div v-else class="hp-bubble hp-typing" aria-label="Assistant is typing">
              <span /><span /><span />
            </div>
          </div>
          <div v-if="status" class="hp-status">{{ status }}</div>
          <div v-if="handedOff" class="hp-banner" part="banner">
            Thanks — a team member will follow up by email{{ visitorEmail ? ` at ${visitorEmail}` : '' }}.
            You can keep chatting here in the meantime.
          </div>
        </div>

        <div v-if="panel" class="hp-form" part="form">
          <p class="hp-form-text">
            {{ appearance.handoff_prompt }}
          </p>
          <form @submit.prevent="handoff">
            <input
              ref="emailEl"
              v-model="emailDraft"
              class="hp-input"
              type="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              aria-label="Your email"
            >
            <div class="hp-form-actions">
              <button type="button" class="hp-link" @click="panel = null">Cancel</button>
              <button type="submit" class="hp-btn" :disabled="formBusy">
                Send to the team
              </button>
            </div>
          </form>
          <p v-if="formError" class="hp-error">{{ formError }}</p>
        </div>

        <div v-if="error" class="hp-error hp-error-bar">{{ error }}</div>

        <!-- The form above replaces the composer and footer, so there's only one text box to type in. -->
        <form v-if="!panel" class="hp-composer" part="composer" @submit.prevent="send">
          <textarea
            ref="inputEl"
            v-model="input"
            class="hp-textarea"
            rows="1"
            maxlength="2000"
            :placeholder="appearance.placeholder"
            aria-label="Your question"
            @keydown="onKeydown"
          />
          <button class="hp-send" type="submit" :disabled="sending || !input.trim()" aria-label="Send" part="send">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2-7-8-1z" /></svg>
          </button>
        </form>

        <footer v-if="!panel" class="hp-footer">
          <span class="hp-disclaimer">AI-generated answers can be wrong.</span>
          <button
            v-if="config.handoffAvailable && !handedOff"
            type="button"
            class="hp-link"
            :disabled="!hasUserMessage"
            :title="hasUserMessage ? '' : 'Ask a question first'"
            @click="openPanel('handoff')"
          >
            Still need help?
          </button>
        </footer>
      </template>
    </section>

    <button
      class="hp-launcher"
      part="launcher"
      type="button"
      :aria-label="isOpen ? 'Close help' : appearance.title"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
    >
      <svg v-if="!isOpen" class="hp-logo" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l9.4 18h-3.9L12 9.5 6.5 21H2.6z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  </div>
</template>

<style>
/*
 * Per-site styling: set any of these on the element (or an ancestor) from the
 * host page. Custom properties inherit through the Shadow DOM boundary.
 *   --helpinator-primary       accent colour (default: the widget's configured colour)
 *   --helpinator-on-primary    text/icon colour on the accent (default #fff)
 *   --helpinator-bg            panel background        --helpinator-text   panel text
 *   --helpinator-muted         secondary text          --helpinator-border borders
 *   --helpinator-bot-bubble    assistant bubble bg     --helpinator-font   font stack
 *   --helpinator-user-bubble   visitor bubble bg (default: primary, darkened so it
 *                              stays distinct from the header when scrolled under it)
 *   --helpinator-radius        corner radius           --helpinator-z-index
 *   --helpinator-offset-x / --helpinator-offset-y     distance from the corner
 *   --helpinator-width / --helpinator-height          panel size
 * Parts for deeper overrides: launcher, panel, header, message, user-message,
 * bot-message, sender, starters, starter, composer, send, form, banner.
 */
:host {
  all: initial;
}

.hp-root {
  --hp-primary: var(--helpinator-primary, var(--hp-default-primary));
  --hp-on-primary: var(--helpinator-on-primary, #ffffff);
  --hp-bg: var(--helpinator-bg, #ffffff);
  --hp-text: var(--helpinator-text, #18181b);
  --hp-muted: var(--helpinator-muted, #71717a);
  --hp-border: var(--helpinator-border, #e4e4e7);
  --hp-bot-bubble: var(--helpinator-bot-bubble, #f4f4f5);
  --hp-user-bubble: var(--helpinator-user-bubble, color-mix(in oklab, var(--hp-primary) 82%, black));
  --hp-radius: var(--helpinator-radius, 14px);
  position: fixed;
  bottom: var(--helpinator-offset-y, 20px);
  z-index: var(--helpinator-z-index, 2147483000);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  font-family: var(--helpinator-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  font-size: 14px;
  line-height: 1.45;
  color: var(--hp-text);
}
.hp-right { right: var(--helpinator-offset-x, 20px); }
.hp-left { left: var(--helpinator-offset-x, 20px); align-items: flex-start; }
.hp-right .hp-panel { right: var(--helpinator-offset-x, 20px); }
.hp-left .hp-panel { left: var(--helpinator-offset-x, 20px); }

.hp-launcher {
  width: 56px;
  height: 56px;
  border-radius: 999px;
  border: none;
  background: var(--hp-primary);
  color: var(--hp-on-primary);
  cursor: pointer;
  display: grid;
  place-items: center;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.2);
}
.hp-launcher svg { width: 26px; height: 26px; }
.hp-launcher svg.hp-logo { fill: currentColor; stroke: none; }

svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/*
 * The panel is fixed to the viewport, not stacked on the launcher: when the
 * launcher is raised (e.g. above a sticky footer) the panel slides down over it
 * rather than running off the top of the screen. It closes from its own header.
 */
.hp-panel {
  --hp-vh: 100vh;
  --hp-panel-height: min(var(--helpinator-height, 560px), calc(var(--hp-vh) - 32px));
  position: fixed;
  bottom: clamp(16px, calc(var(--helpinator-offset-y, 20px) + 68px), calc(var(--hp-vh) - var(--hp-panel-height) - 16px));
  width: min(var(--helpinator-width, 370px), calc(100vw - 32px));
  height: var(--hp-panel-height);
  background: var(--hp-bg);
  border: 1px solid var(--hp-border);
  border-radius: var(--hp-radius);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* dvh tracks mobile browser chrome; older browsers keep the vh fallback above.
   (A plain duplicate declaration can't fall back — var() makes both parse.) */
@supports (height: 100dvh) {
  .hp-panel { --hp-vh: 100dvh; }
}

.hp-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 12px 12px 16px;
  background: var(--hp-primary);
  color: var(--hp-on-primary);
}
.hp-heading { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.hp-title { font-weight: 600; font-size: 15px; }
.hp-subtitle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  opacity: 0.85;
}
.hp-subtitle svg { width: 12px; height: 12px; }
.hp-icon-btn {
  border: none;
  background: transparent;
  color: inherit;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.hp-icon-btn:hover { background: rgb(255 255 255 / 0.15); }
.hp-icon-btn svg { width: 18px; height: 18px; }

.hp-unavailable { padding: 24px 16px; color: var(--hp-muted); }

.hp-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hp-msg { display: flex; }
.hp-user { justify-content: flex-end; }
.hp-bot { flex-direction: column; align-items: flex-start; gap: 2px; }
.hp-sender {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--hp-muted);
}
.hp-sender svg { width: 11px; height: 11px; }
.hp-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px;
  overflow-wrap: anywhere;
}
.hp-user .hp-bubble {
  background: var(--hp-user-bubble);
  color: var(--hp-on-primary);
  white-space: pre-wrap;
  border-bottom-right-radius: 4px;
}
.hp-bot .hp-bubble {
  background: var(--hp-bot-bubble);
  border-bottom-left-radius: 4px;
}
.hp-bubble p { margin: 0 0 6px; }
.hp-bubble p:last-child { margin-bottom: 0; }
.hp-bubble ul, .hp-bubble ol { margin: 4px 0; padding-left: 20px; }
.hp-bubble a { color: inherit; text-decoration: underline; }
.hp-bubble code { font-size: 12px; background: rgb(0 0 0 / 0.06); padding: 1px 4px; border-radius: 4px; }
.hp-bubble pre { overflow-x: auto; }

.hp-typing { display: flex; gap: 4px; align-items: center; min-height: 20px; }
.hp-typing span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--hp-muted);
  animation: hp-blink 1.2s infinite ease-in-out;
}
.hp-typing span:nth-child(2) { animation-delay: 0.2s; }
.hp-typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes hp-blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

.hp-starters {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.hp-starter {
  max-width: 85%;
  padding: 6px 12px;
  border: 1px solid var(--hp-primary);
  border-radius: 999px;
  background: var(--hp-bg);
  color: var(--hp-primary);
  font: inherit;
  font-size: 13px;
  text-align: right;
  cursor: pointer;
}
.hp-starter:hover { background: color-mix(in srgb, var(--hp-primary) 8%, var(--hp-bg)); }
.hp-starter:disabled { opacity: 0.6; cursor: default; }

.hp-status { font-size: 12px; color: var(--hp-muted); }
.hp-banner {
  font-size: 13px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--hp-border);
  background: color-mix(in srgb, var(--hp-primary) 8%, var(--hp-bg));
}

.hp-form { padding: 12px 14px; border-top: 1px solid var(--hp-border); }
.hp-form-text { margin: 0 0 8px; font-size: 13px; }
.hp-form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; align-items: center; }
.hp-input {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--hp-border);
  border-radius: 8px;
  font: inherit;
  color: inherit;
  background: var(--hp-bg);
}
.hp-btn {
  border: none;
  background: var(--hp-primary);
  color: var(--hp-on-primary);
  padding: 7px 14px;
  border-radius: 8px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.hp-btn:disabled { opacity: 0.6; cursor: default; }

.hp-error { color: #b91c1c; font-size: 12px; margin: 6px 0 0; }
.hp-error-bar { padding: 0 14px 6px; margin: 0; }

.hp-composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 10px 12px;
  border-top: 1px solid var(--hp-border);
}
.hp-textarea {
  flex: 1;
  resize: none;
  max-height: 120px;
  padding: 8px 10px;
  border: 1px solid var(--hp-border);
  border-radius: 10px;
  font: inherit;
  color: inherit;
  background: var(--hp-bg);
  field-sizing: content;
}
.hp-textarea:focus, .hp-input:focus { outline: 2px solid var(--hp-primary); outline-offset: -1px; }
.hp-send {
  width: 38px;
  height: 38px;
  border: none;
  border-radius: 10px;
  background: var(--hp-primary);
  color: var(--hp-on-primary);
  cursor: pointer;
  display: grid;
  place-items: center;
}
.hp-send:disabled { opacity: 0.5; cursor: default; }
.hp-send svg { width: 18px; height: 18px; }

.hp-footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px 10px;
  min-height: 4px;
}
.hp-disclaimer { font-size: 12px; color: var(--hp-muted); }
.hp-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--hp-muted);
  text-decoration: underline;
  cursor: pointer;
}
.hp-link:disabled { opacity: 0.5; cursor: default; }
</style>
