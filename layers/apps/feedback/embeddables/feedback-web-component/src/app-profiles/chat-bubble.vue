<script setup>
/**
 * chat-bubble — floating bubble + panel profile.
 *
 * All layout positioning is owned by the outer `.feedback-widget-slot`
 * wrapper in slot.css. This component only sizes/styles its own bubble and
 * panel; it does NOT use position:fixed. To move the bubble, override the
 * slot CSS on the host page.
 */

import { ref, reactive, onMounted, onBeforeUnmount, watch, inject, computed, nextTick } from 'vue'
import { useFeedback } from '../composables/useFeedback.js'
import { useScreenshot } from '../composables/useScreenshot.js'

const projectIdRef = inject('projectId')
const feedback = useFeedback()
const {
  auth,
  project,
  projectError,
  loadProject,
  submissions,
  submissionsLoading,
  submissionsError,
  refreshMe,
  beginSignIn,
  completeSignInFromUrl,
  logout,
  loadSubmissions,
  submit,
  bindStorageSync,
  firstParty
} = feedback

const open = ref(false)
const activeTab = ref('submit')

const expandedId = ref(null)
const submitting = ref(false)
const submitError = ref('')
const submitOk = ref(false)
const userMenuOpen = ref(false)
const signingIn = ref(false)

// Persisted across the sign-in full-page redirect so we can reopen the panel on
// the user's return and drop them on the "My Submissions" tab.
const REOPEN_KEY = 'fw-reopen'

// Cross-origin sign-in navigates the whole page to the host and back. First-
// party (in-app) sessions already authenticate via the cookie, so there sign-in
// is never offered.
async function onSignIn() {
  if (signingIn.value) return
  signingIn.value = true
  try { localStorage.setItem(REOPEN_KEY, '1') } catch { /* ignore */ }
  await beginSignIn()
}

const SUB_TYPES = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' }
]
const SUB_TYPE_LABEL = { bug: 'Bug', idea: 'Idea' }
const STATUS_LABEL = {
  new: 'New',
  triage_needed: 'Triage',
  in_progress: 'In progress',
  rejected: 'Rejected',
  accepted: 'Accepted'
}
const charCap = 2000

// Remember the submitter's name across submissions and reloads (anonymous users
// only — authed users submit under their profile, so the name field is hidden).
// Persisted to localStorage so a returning visitor doesn't retype it.
const NAME_KEY = 'fw-name'
function loadSavedName() {
  try { return localStorage.getItem(NAME_KEY) || '' } catch { return '' }
}
function saveName(name) {
  try {
    if (name) localStorage.setItem(NAME_KEY, name)
    else localStorage.removeItem(NAME_KEY)
  } catch { /* ignore */ }
}

const form = reactive({
  submitter_name: loadSavedName(),
  feedback_sub_type: 'bug',
  problem_description: '',
  suggested_fix: ''
})

// Screenshot + attachments state. Mirrors the server-side limits in
// /api/v1/feedback (10MB per file, 25MB total, 4 user attachments + 1 screenshot).
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENTS = 4
const ALLOWED_ATTACHMENT_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'application/zip'
])

const screenshot = ref(null)         // File | null
const screenshotPreview = ref('')    // object URL for thumbnail
const screenshotBusy = ref(false)
const screenshotError = ref('')
const attachments = ref([])          // File[]
const attachmentError = ref('')
const fileInputRef = ref(null)

const { capture: captureScreenshot } = useScreenshot()

function totalUploadBytes() {
  let total = screenshot.value?.size || 0
  for (const f of attachments.value) total += f.size
  return total
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function applyScreenshotBlob(blob) {
  if (screenshotPreview.value) URL.revokeObjectURL(screenshotPreview.value)
  screenshot.value = new File([blob], 'screenshot.png', { type: 'image/png' })
  screenshotPreview.value = URL.createObjectURL(blob)
}

async function takeScreenshot() {
  screenshotError.value = ''
  screenshotBusy.value = true
  // Hide the panel and bubble while html2canvas paints so the feedback UI
  // never ends up in the screenshot. The ignoreElements predicate is a belt
  // for the suspenders, but closing the panel guarantees it visually.
  const wasOpen = open.value
  open.value = false
  await nextTick()
  // Give the browser one paint frame to actually unmount the panel.
  await new Promise(r => requestAnimationFrame(() => r()))
  try {
    const blob = await captureScreenshot()
    if (!blob) throw new Error('Capture failed')
    if (blob.size > MAX_FILE_BYTES) {
      throw new Error(`Screenshot is ${formatBytes(blob.size)} (max 10 MB)`)
    }
    if (totalUploadBytes() + blob.size - (screenshot.value?.size || 0) > MAX_TOTAL_BYTES) {
      throw new Error('Total upload would exceed 25 MB')
    }
    applyScreenshotBlob(blob)
  } catch (e) {
    screenshotError.value = e.message || 'Screenshot failed'
  } finally {
    screenshotBusy.value = false
    open.value = wasOpen
  }
}

// Auto-capture a screenshot of the visible screen when the panel first opens,
// so a bug report ships with a screenshot by default. Unlike takeScreenshot()
// this never touches `open` — the panel stays put and the feedback UI is left
// out of the capture by useScreenshot's ignoreElements predicate. It only runs
// when there's no screenshot yet, so a manual "Replace screenshot" wins.
async function autoScreenshot() {
  if (screenshot.value || screenshotBusy.value) return
  screenshotError.value = ''
  screenshotBusy.value = true
  try {
    // Let the panel commit to the DOM, then give the browser a paint frame so
    // html2canvas renders against settled layout.
    await nextTick()
    await new Promise(r => requestAnimationFrame(() => r()))
    const blob = await captureScreenshot()
    if (!blob || blob.size > MAX_FILE_BYTES) return
    if (totalUploadBytes() + blob.size > MAX_TOTAL_BYTES) return
    applyScreenshotBlob(blob)
  } catch {
    // Auto-capture is best-effort; stay silent and let the user grab one
    // manually if it fails.
  } finally {
    screenshotBusy.value = false
  }
}

function clearScreenshot() {
  if (screenshotPreview.value) URL.revokeObjectURL(screenshotPreview.value)
  screenshot.value = null
  screenshotPreview.value = ''
  screenshotError.value = ''
}

function pickAttachments() {
  fileInputRef.value?.click()
}

function onAttachmentsPicked(ev) {
  attachmentError.value = ''
  const picked = Array.from(ev.target.files || [])
  for (const file of picked) {
    if (attachments.value.length >= MAX_ATTACHMENTS) {
      attachmentError.value = `Up to ${MAX_ATTACHMENTS} attachments`
      break
    }
    if (file.size > MAX_FILE_BYTES) {
      attachmentError.value = `${file.name} is ${formatBytes(file.size)} (max 10 MB)`
      continue
    }
    if (file.type && !ALLOWED_ATTACHMENT_MIME.has(file.type)) {
      attachmentError.value = `${file.name}: unsupported type`
      continue
    }
    if (totalUploadBytes() + file.size > MAX_TOTAL_BYTES) {
      attachmentError.value = 'Total upload would exceed 25 MB'
      break
    }
    attachments.value.push(file)
  }
  // Reset input so the same file can be picked again after a remove.
  ev.target.value = ''
}

function removeAttachment(index) {
  attachments.value.splice(index, 1)
  attachmentError.value = ''
}

const apiBase = inject('apiBase')
const apiBaseReady = computed(() => Boolean(apiBase?.value))

function resetForm() {
  form.submitter_name = loadSavedName()
  form.feedback_sub_type = 'bug'
  form.problem_description = ''
  form.suggested_fix = ''
  clearScreenshot()
  attachments.value = []
  attachmentError.value = ''
}

function validate() {
  if (!auth.isAuthed && !form.submitter_name.trim()) return 'Your name is required.'
  // Each type has one required field; the complementary field is optional.
  if (form.feedback_sub_type === 'idea') {
    if (!form.suggested_fix.trim()) return 'Please describe your idea.'
  } else {
    if (!form.problem_description.trim()) return 'Please describe the problem.'
  }
  return ''
}

async function doSubmit() {
  submitError.value = ''
  submitOk.value = false
  const err = validate()
  if (err) { submitError.value = err; return }
  submitting.value = true
  try {
    await submit({
      feedback_sub_type: form.feedback_sub_type,
      problem_description: form.problem_description.trim(),
      suggested_fix: form.suggested_fix.trim(),
      submitter_name: form.submitter_name.trim()
    }, {
      screenshot: screenshot.value,
      attachments: attachments.value
    })
    submitOk.value = true
    saveName(form.submitter_name.trim())
    resetForm()
    autoScreenshot()
    setTimeout(() => { submitOk.value = false }, 2500)
  } catch (e) {
    submitError.value = e.message || 'Submit failed.'
  } finally {
    submitting.value = false
  }
}

function toggleExpanded(id) {
  expandedId.value = expandedId.value === id ? null : id
}

function truncate(s, n = 60) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

// List title comes from each type's primary field (an idea's idea, a bug's
// problem).
function itemTitle(s) {
  const primary = s.feedback_sub_type === 'idea' ? s.suggested_fix : s.problem_description
  return primary || s.problem_description || s.suggested_fix || 'Feedback'
}

function handleLogout() {
  userMenuOpen.value = false
  logout()
}

function handleDocumentClick() {
  if (userMenuOpen.value) userMenuOpen.value = false
}

let unbindStorage = null
onMounted(async () => {
  unbindStorage = bindStorageSync()
  loadProject()
  document.addEventListener('click', handleDocumentClick)

  // Finish a sign-in if we just came back from the host's connect bridge.
  const returned = await completeSignInFromUrl()

  // Reopen the panel (on the "My Submissions" tab) when returning from the
  // redirect, so the user lands back where they started.
  let reopen = false
  try {
    reopen = localStorage.getItem(REOPEN_KEY) === '1'
    if (reopen) localStorage.removeItem(REOPEN_KEY)
  } catch { /* ignore */ }
  if (returned || reopen) {
    open.value = true
    activeTab.value = 'mine'
  }
  signingIn.value = false

  // First-party mode authenticates via the host session cookie; cross-origin
  // uses a stored bearer token. Either way, refresh to pick up the user. (After
  // a fresh exchange above, auth.user is already set; this reconciles reloads.)
  if (auth.token || firstParty.value) {
    refreshMe().then(() => auth.isAuthed && loadSubmissions())
  }
})
onBeforeUnmount(() => {
  unbindStorage && unbindStorage()
  document.removeEventListener('click', handleDocumentClick)
})

watch(() => projectIdRef?.value, () => {
  loadProject()
  if (auth.isAuthed) loadSubmissions()
})
watch(open, (v) => {
  if (!v) return
  if (auth.isAuthed && !submissions.value.length) loadSubmissions()
  autoScreenshot()
})
</script>

<template>
  <div class="fw-root" :data-project="projectIdRef">
    <transition name="fw-panel">
      <div v-if="open" class="fw-panel" role="dialog" aria-label="Feedback">
        <header class="fw-header">
          <div class="fw-title">
            <span class="fw-dot" />
            <span>Feedback</span>
            <span v-if="project?.name" class="fw-project" :title="projectIdRef">
              · {{ truncate(project.name, 24) }}
            </span>
          </div>
          <div class="fw-header-right">
            <div v-if="auth.isAuthed" class="fw-user">
              <button
                class="fw-user-btn"
                :aria-expanded="userMenuOpen"
                aria-haspopup="menu"
                @click.stop="userMenuOpen = !userMenuOpen"
              >
                {{ auth.user?.display_name || auth.user?.email }}
                <span class="fw-caret" :class="{ open: userMenuOpen }">▾</span>
              </button>
              <div v-if="userMenuOpen" class="fw-user-menu" role="menu" @click.stop>
                <div class="fw-user-menu-email" :title="auth.user?.email">
                  {{ auth.user?.email }}
                </div>
                <button
                  class="fw-user-menu-item"
                  role="menuitem"
                  @click="handleLogout"
                >Log out</button>
              </div>
            </div>
            <button
              v-else
              class="fw-header-signin"
              type="button"
              :disabled="signingIn"
              @click="onSignIn"
            >Sign in</button>
            <button class="fw-close" aria-label="Close" @click="open = false">×</button>
          </div>
        </header>

        <div v-if="!apiBaseReady" class="fw-alert fw-alert-error fw-alert-inline">
          <strong>apiBase</strong> missing from <code>profile-config</code>.
        </div>

        <template v-else>
          <div v-if="projectError" class="fw-alert fw-alert-error fw-alert-inline">
            {{ projectError }}
          </div>

          <div v-if="project" class="fw-project-banner">
            Sending feedback to
            <strong>{{ project.name }}</strong>
          </div>

          <div v-if="auth.authError" class="fw-alert fw-alert-error fw-alert-inline">
            {{ auth.authError }}
          </div>

            <nav class="fw-tabs" role="tablist">
              <button
                role="tab"
                :aria-selected="activeTab === 'submit'"
                :class="{ active: activeTab === 'submit' }"
                @click="activeTab = 'submit'"
              >Submit</button>
              <button
                role="tab"
                :aria-selected="activeTab === 'mine'"
                :class="{ active: activeTab === 'mine' }"
                @click="activeTab = 'mine'; auth.isAuthed && loadSubmissions()"
              >
                My Submissions
                <span v-if="auth.isAuthed && submissions.length" class="fw-count">
                  {{ submissions.length }}
                </span>
              </button>
            </nav>

          <section v-if="activeTab === 'submit'" class="fw-body">
            <label v-if="!auth.isAuthed" class="fw-field">
              <span>Your name</span>
              <input
                v-model="form.submitter_name"
                type="text"
                placeholder="e.g. 'Jane Doe'"
                maxlength="100"
                required
              />
            </label>

            <div class="fw-field">
              <span>Type</span>
              <div class="fw-segments" role="group" aria-label="Feedback type">
                <button
                  v-for="t in SUB_TYPES"
                  :key="t.value"
                  type="button"
                  class="fw-segment"
                  :class="{ active: form.feedback_sub_type === t.value }"
                  :aria-pressed="form.feedback_sub_type === t.value"
                  @click="form.feedback_sub_type = t.value"
                >{{ t.label }}</button>
              </div>
            </div>

            <template v-if="form.feedback_sub_type === 'idea'">
              <label class="fw-field">
                <span>What is your idea?</span>
                <textarea
                  v-model="form.suggested_fix"
                  rows="3"
                  placeholder="e.g. 'Let me export the table to CSV.'"
                  :maxlength="charCap"
                />
              </label>

              <label class="fw-field">
                <span>What problem does it solve? <em>(optional)</em></span>
                <textarea
                  v-model="form.problem_description"
                  rows="3"
                  placeholder="Why would this help?"
                  :maxlength="charCap"
                />
              </label>
            </template>

            <template v-else>
              <label class="fw-field">
                <span>What is the problem?</span>
                <textarea
                  v-model="form.problem_description"
                  rows="3"
                  placeholder="e.g. 'Typo in the page title — it should say &quot;Example&quot;.'"
                  :maxlength="charCap"
                />
              </label>

              <label class="fw-field">
                <span>Suggested solution <em>(optional)</em></span>
                <textarea
                  v-model="form.suggested_fix"
                  rows="3"
                  placeholder="Change it to…"
                  :maxlength="charCap"
                />
              </label>
            </template>

            <div class="fw-uploads">
              <div class="fw-uploads-row">
                <button
                  type="button"
                  class="fw-upload-btn"
                  :disabled="screenshotBusy"
                  @click="takeScreenshot"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span v-if="screenshotBusy">Capturing…</span>
                  <span v-else-if="screenshot">Replace screenshot</span>
                  <span v-else>Take screenshot</span>
                </button>

                <button
                  type="button"
                  class="fw-upload-btn"
                  :disabled="attachments.length >= MAX_ATTACHMENTS"
                  @click="pickAttachments"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                  <span>Attach files</span>
                </button>

                <input
                  ref="fileInputRef"
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,application/zip"
                  hidden
                  @change="onAttachmentsPicked"
                >
              </div>

              <div v-if="screenshot" class="fw-screenshot-preview">
                <a
                  :href="screenshotPreview"
                  target="_blank"
                  rel="noopener"
                  class="fw-screenshot-thumb"
                  title="Open full-size in a new tab"
                >
                  <img :src="screenshotPreview" alt="Screenshot preview" />
                </a>
                <div class="fw-screenshot-meta">
                  <span class="fw-attach-name">screenshot.png</span>
                  <span class="fw-attach-size">{{ formatBytes(screenshot.size) }}</span>
                </div>
                <button
                  type="button"
                  class="fw-attach-remove"
                  aria-label="Remove screenshot"
                  @click="clearScreenshot"
                >×</button>
              </div>
              <div v-if="screenshotError" class="fw-alert fw-alert-error fw-alert-inline">
                {{ screenshotError }}
              </div>

              <ul v-if="attachments.length" class="fw-attach-list">
                <li v-for="(file, i) in attachments" :key="i" class="fw-attach-item">
                  <span class="fw-attach-name" :title="file.name">{{ file.name }}</span>
                  <span class="fw-attach-size">{{ formatBytes(file.size) }}</span>
                  <button
                    type="button"
                    class="fw-attach-remove"
                    :aria-label="`Remove ${file.name}`"
                    @click="removeAttachment(i)"
                  >×</button>
                </li>
              </ul>
              <div v-if="attachmentError" class="fw-alert fw-alert-error fw-alert-inline">
                {{ attachmentError }}
              </div>
            </div>

            <div v-if="submitError" class="fw-alert fw-alert-error">{{ submitError }}</div>
            <div v-if="submitOk" class="fw-alert fw-alert-ok">Thanks — feedback submitted.</div>

            <button class="fw-submit" :disabled="submitting" @click="doSubmit">
              {{ submitting ? 'Sending…' : 'Submit feedback' }}
            </button>
          </section>

          <section v-else class="fw-body">
            <div v-if="!auth.isAuthed" class="fw-signin-cta">
              <div class="fw-signin-cta-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>
              </div>
              <div class="fw-signin-cta-title">
                Track your feedback
              </div>
              <div class="fw-signin-cta-body">
                Sign in to see your past submissions and track their status as
                the team works on them.
              </div>
              <div class="fw-signin-cta-actions">
                <button class="fw-submit" type="button" :disabled="signingIn" @click="onSignIn">
                  {{ signingIn ? 'Redirecting…' : 'Sign in' }}
                </button>
              </div>
            </div>

            <div v-else-if="submissionsLoading" class="fw-empty">Loading…</div>
            <div v-else-if="submissionsError" class="fw-alert fw-alert-error">
              {{ submissionsError }}
            </div>
            <div v-else-if="!submissions.length" class="fw-empty">
              No submissions yet on this project.
            </div>
            <ul v-else class="fw-list">
              <li
                v-for="s in submissions"
                :key="s.id"
                class="fw-item"
                :class="{ open: expandedId === s.id }"
              >
                <button class="fw-item-head" @click="toggleExpanded(s.id)">
                  <span class="fw-item-title">{{ truncate(itemTitle(s), 48) }}</span>
                  <span class="fw-item-meta">
                    <span :class="['fw-badge', 'fw-badge-' + s.status]">
                      {{ STATUS_LABEL[s.status] || s.status }}
                    </span>
                    <time>{{ new Date(s.created_at).toLocaleDateString() }}</time>
                  </span>
                </button>
                <div v-if="expandedId === s.id" class="fw-item-body">
                  <dl>
                    <dt>Type</dt>
                    <dd>{{ SUB_TYPE_LABEL[s.feedback_sub_type] || s.feedback_sub_type }}</dd>
                    <template v-if="s.feedback_sub_type === 'idea'">
                      <dt v-if="s.suggested_fix">Idea</dt>
                      <dd v-if="s.suggested_fix">{{ s.suggested_fix }}</dd>
                      <dt v-if="s.problem_description">Problem it solves</dt>
                      <dd v-if="s.problem_description">{{ s.problem_description }}</dd>
                    </template>
                    <template v-else>
                      <dt v-if="s.problem_description">Problem</dt>
                      <dd v-if="s.problem_description">{{ s.problem_description }}</dd>
                      <dt v-if="s.suggested_fix">Suggested solution</dt>
                      <dd v-if="s.suggested_fix">{{ s.suggested_fix }}</dd>
                    </template>
                    <dt v-if="s.page_path">Page</dt>
                    <dd v-if="s.page_path">{{ s.page_path }}</dd>
                    <dt v-if="s.attachments?.length">Attachments</dt>
                    <dd v-if="s.attachments?.length" class="fw-item-attachments">
                      <a
                        v-for="a in s.attachments"
                        :key="a.id"
                        :href="a.url"
                        target="_blank"
                        rel="noopener"
                        class="fw-item-attachment"
                      >
                        <img v-if="a.mime_type?.startsWith('image/')" :src="a.url" :alt="a.filename" />
                        <span v-else class="fw-item-attachment-icon">📎</span>
                        <span class="fw-item-attachment-name">{{ a.filename }}</span>
                      </a>
                    </dd>
                  </dl>
                </div>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </transition>

    <button
      class="fw-bubble"
      :class="{ open }"
      :aria-expanded="open"
      aria-label="Open feedback"
      @click="open = !open"
    >
      <svg v-if="!open" xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 -960 960 960" width="16" fill="#1f1f1f" style="display:block;margin:auto;">
        <path d="M480-200q66 0 113-47t47-113v-160q0-66-47-113t-113-47q-66 0-113 47t-47 113v160q0 66 47 113t113 47Zm-80-120h160v-80H400v80Zm0-160h160v-80H400v80Zm80 40Zm0 320q-65 0-120.5-32T272-240H160v-80h84q-3-20-3.5-40t-.5-40h-80v-80h80q0-20 .5-40t3.5-40h-84v-80h112q14-23 31.5-43t40.5-35l-64-66 56-56 86 86q28-9 57-9t57 9l88-86 56 56-66 66q23 15 41.5 34.5T688-640h112v80h-84q3 20 3.5 40t.5 40h80v80h-80q0 20-.5 40t-3.5 40h84v80H688q-32 56-87.5 88T480-120Z"/>
      </svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style>
/*
 * All styles below scope to the chat-bubble profile. Positioning is the SLOT's
 * job — see slot.css. The web component fills its slot.
 */

:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1f2937;
}

.fw-root {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

.fw-bubble {
  width: 26px;
  height: 26px;
  border-radius: 0;
  border: none;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.35);
  transition: transform 0.15s ease, background 0.15s ease;
}
.fw-bubble:hover { background: #1d4ed8; transform: translateY(-1px); }
.fw-bubble.open { background: #111827; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25); }

.fw-panel {
  width: 360px;
  max-width: calc(100vw - 24px);
  max-height: 70vh;
  margin-right: 12px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.fw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #111827;
  color: #fff;
  gap: 8px;
}
.fw-title { display: flex; align-items: center; gap: 8px; font-weight: 600; min-width: 0; }
.fw-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25); flex-shrink: 0; }
.fw-project { font-weight: 400; font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fw-header-right { display: flex; align-items: center; gap: 8px; }

.fw-user { position: relative; }
.fw-user-btn {
  background: rgba(255,255,255,0.1);
  border: none;
  color: #fff;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: inherit;
}
.fw-user-btn:hover { background: rgba(255,255,255,0.2); }
.fw-caret { font-size: 9px; opacity: 0.7; transition: transform 0.15s ease; }
.fw-caret.open { transform: rotate(180deg); }

.fw-user-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  z-index: 10;
}
.fw-user-menu-email {
  padding: 8px 12px;
  font-size: 11px;
  color: #6b7280;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fw-user-menu-item {
  width: 100%;
  padding: 8px 12px;
  background: #fff;
  color: #111827;
  border: none;
  text-align: left;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.fw-user-menu-item:hover { background: #f3f4f6; }
.fw-bubble {
  width: 26px;
  height: 26px;
  border-radius: 0;
  border: none;
  background: #fff;
  color: #2563eb;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.18);
  padding: 0;
  transition: transform 0.15s ease, background 0.15s ease;
}
.fw-bubble:hover { background: #f3f4f6; transform: translateY(-1px) scale(1.04); }
.fw-bubble.open { background: #e5e7eb; filter: grayscale(0.5) opacity(0.7); }
.fw-bubble:hover { filter: brightness(1.08) drop-shadow(0 2px 8px #2563eb33); transform: translateY(-1px) scale(1.04); }
.fw-bubble.open { filter: grayscale(0.5) opacity(0.7); }

.fw-close {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  opacity: 0.75;
}
.fw-close:hover { opacity: 1; }

.fw-tabs { display: flex; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
.fw-tabs button {
  flex: 1;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.fw-tabs button.active { color: #111827; border-bottom-color: #2563eb; background: #fff; }
.fw-count { background: #e5e7eb; color: #374151; font-size: 11px; padding: 1px 6px; border-radius: 10px; }

.fw-body { padding: 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }

.fw-project-banner {
  padding: 8px 14px;
  background: #eff6ff;
  border-bottom: 1px solid #dbeafe;
  font-size: 12px;
  color: #1e40af;
}
.fw-project-banner strong {
  color: #1e3a8a;
  font-weight: 600;
}

.fw-auth-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
.fw-auth-tabs button {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #6b7280;
  font-weight: 500;
}
.fw-auth-tabs button.active { background: #2563eb; color: #fff; border-color: #2563eb; }
.fw-auth form { display: flex; flex-direction: column; gap: 10px; }

.fw-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #374151; }
.fw-field span { font-weight: 500; }
.fw-field em { font-style: normal; color: #9ca3af; font-weight: 400; }
.fw-field input,
.fw-field select,
.fw-field textarea {
  font: inherit;
  color: #111827;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  resize: vertical;
}
.fw-field input:focus,
.fw-field select:focus,
.fw-field textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}

.fw-segments {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 8px;
}
.fw-segment {
  flex: 1;
  padding: 7px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.fw-segment:hover { color: #374151; }
.fw-segment.active {
  background: #fff;
  color: #111827;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.fw-segment:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}

.fw-submit {
  margin-top: 4px;
  padding: 10px 12px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}
.fw-submit:hover { background: #1d4ed8; }
.fw-submit-ghost {
  background: #fff;
  color: #2563eb;
  border: 1px solid #2563eb;
}
.fw-submit-ghost:hover { background: #eff6ff; }

.fw-back {
  background: transparent;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 4px 6px;
  align-self: flex-start;
  border-radius: 4px;
  margin-bottom: 2px;
}
.fw-back:hover { background: #f3f4f6; color: #111827; }

.fw-header-signin {
  background: #2563eb;
  color: #fff;
  border: none;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.fw-header-signin:hover { background: #1d4ed8; }

.fw-signin-cta {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 12px 6px;
}
.fw-signin-cta-icon {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #eff6ff;
  color: #2563eb;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fw-signin-cta-title {
  font-weight: 600;
  font-size: 14px;
  color: #111827;
}
.fw-signin-cta-body {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.5;
  max-width: 280px;
}
.fw-signin-cta-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
}
.fw-signin-cta-actions .fw-submit { width: 100%; }
.fw-submit:disabled { background: #93c5fd; cursor: not-allowed; }

.fw-alert { padding: 8px 10px; border-radius: 6px; font-size: 12px; }
.fw-alert-inline { margin: 14px 14px 0; }
.fw-alert-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.fw-alert-ok { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }

.fw-empty { padding: 24px 8px; color: #9ca3af; text-align: center; font-size: 13px; }

.fw-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.fw-item { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #fff; }
.fw-item.open { border-color: #c7d2fe; }
.fw-item-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
.fw-item-head:hover { background: #f9fafb; }
.fw-item-title { font-weight: 500; color: #111827; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fw-item-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 11px; color: #6b7280; }
.fw-badge { padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; }
.fw-badge-new { background: #dbeafe; color: #1d4ed8; }
.fw-badge-triage_needed { background: #fef3c7; color: #92400e; }
.fw-badge-in_progress { background: #ede9fe; color: #5b21b6; }
.fw-badge-rejected { background: #fee2e2; color: #991b1b; }
.fw-badge-accepted { background: #dcfce7; color: #166534; }

.fw-item-body { padding: 0 12px 12px; font-size: 12px; color: #374151; }
.fw-item-body dl { display: grid; grid-template-columns: 90px 1fr; gap: 4px 10px; margin: 0; }
.fw-item-body dt { color: #6b7280; font-weight: 500; }
.fw-item-body dd { margin: 0; word-break: break-word; }
.fw-item-attachments { display: flex; flex-direction: column; gap: 4px; }
.fw-item-attachment {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
  text-decoration: none;
  color: #1f2937;
  font-size: 11px;
}
.fw-item-attachment:hover { background: #f3f4f6; border-color: #d1d5db; }
.fw-item-attachment img {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}
.fw-item-attachment-icon { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.fw-item-attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Screenshot + attachments controls in the submit form */
.fw-uploads { display: flex; flex-direction: column; gap: 8px; }
.fw-uploads-row { display: flex; gap: 8px; flex-wrap: wrap; }
.fw-upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  color: #1f2937;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.fw-upload-btn:hover:not(:disabled) { background: #f9fafb; border-color: #9ca3af; }
.fw-upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.fw-screenshot-preview {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
}
.fw-screenshot-thumb {
  display: block;
  flex-shrink: 0;
  cursor: zoom-in;
  border-radius: 4px;
  transition: opacity 0.1s ease;
}
.fw-screenshot-thumb:hover { opacity: 0.85; }
.fw-screenshot-preview img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
  display: block;
}
.fw-screenshot-meta { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.fw-attach-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.fw-attach-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f9fafb;
  font-size: 12px;
}
.fw-attach-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1f2937; }
.fw-attach-size { color: #6b7280; font-size: 11px; flex-shrink: 0; }
.fw-attach-remove {
  border: none;
  background: transparent;
  color: #6b7280;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
  flex-shrink: 0;
}
.fw-attach-remove:hover { color: #ef4444; }

.fw-panel-enter-active,
.fw-panel-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.fw-panel-enter-from,
.fw-panel-leave-to { opacity: 0; transform: translateY(8px); }
</style>
