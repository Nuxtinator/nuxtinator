/**
 * useFeedback — encapsulates the auth + submit + list-my-feedback flow against
 * the Kanban backend. The chat-bubble profile consumes this; future profiles
 * (inline form, modal) can share it.
 */

import { ref, inject, computed } from 'vue'
import { useAuthStore, TOKEN_KEY } from '../stores/authStore.js'
import { useApi } from './useApi.js'

// localStorage key holding the in-flight sign-in flow (PKCE verifier + CSRF
// state) across the full-page redirect to the host's connect bridge.
const FLOW_KEY = 'fw-auth-flow'

export function useFeedback() {
  const auth = useAuthStore()
  const api = useApi()
  const projectId = inject('projectId')
  const apiBase = inject('apiBase')

  const submissions = ref([])
  const submissionsLoading = ref(false)
  const submissionsError = ref('')

  const project = ref(null)
  const projectError = ref('')

  async function loadProject() {
    project.value = null
    projectError.value = ''
    if (!projectId?.value) return
    try {
      const data = await api.request(`/api/v1/project/${encodeURIComponent(projectId.value)}`)
      project.value = data
    } catch (e) {
      projectError.value = e.status === 404
        ? 'Unknown project — check the projectId in profile-config.'
        : (e.message || 'Failed to load project')
    }
  }

  async function refreshMe() {
    // First-party (in-app) sessions live in an httpOnly cookie, so there's no
    // widget token to gate on — always ask the server who we are. Cross-origin
    // embeds with no bearer token are anonymous and skip the round-trip.
    if (!auth.token && !api.firstParty.value) {
      auth.setUser(null)
      return
    }
    auth.authChecking = true
    auth.authError = ''
    try {
      // Bearer-aware identity endpoint — works first-party (cookie) AND
      // cross-origin (the token from /api/v1/feedback/token). The core
      // /api/auth/me is cookie-only and can't authenticate a cross-origin embed.
      const data = await api.request(`/api/v1/feedback/me?project_id=${encodeURIComponent(projectId?.value || '')}`)
      auth.setUser(data.user)
    } catch (e) {
      if (e.status === 401) auth.reset()
      else auth.authError = e.message
    } finally {
      auth.authChecking = false
    }
  }

  // Kick off cross-origin sign-in: stash a PKCE verifier + CSRF state, then
  // full-page redirect to the host's connect bridge. The page navigates away;
  // completeSignInFromUrl() finishes the exchange when the host sends us back.
  async function beginSignIn() {
    const base = (apiBase?.value || '').replace(/\/$/, '')
    if (!base || !projectId?.value) return
    const verifier = randomUrlToken(32)
    const state = randomUrlToken(16)
    const challenge = await s256Challenge(verifier)
    try {
      localStorage.setItem(FLOW_KEY, JSON.stringify({ verifier, state }))
    } catch { /* ignore */ }
    const redirectUri = window.location.origin + window.location.pathname
    const params = new URLSearchParams({
      project_id: projectId.value,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge
    })
    window.location.assign(`${base}/feedback/connect?${params.toString()}`)
  }

  // On load, finish a sign-in if we returned from the connect bridge with a
  // `?code`. Returns true if a code was present (so the caller can reopen the
  // panel), false otherwise.
  async function completeSignInFromUrl() {
    let params
    try {
      params = new URLSearchParams(window.location.search)
    } catch {
      return false
    }
    // Only our own widget-namespaced params (set by the connect bridge) — never
    // a bare `?code`/`?state`, which the embedding page may own (e.g. its own
    // OAuth callback). So we never read or strip params that aren't ours.
    const code = params.get('fw_code')
    const state = params.get('fw_state')
    if (!code) return false

    // Strip our one-time code + state from the URL so they never linger in
    // history, regardless of whether the exchange below succeeds.
    try {
      params.delete('fw_code')
      params.delete('fw_state')
      const qs = params.toString()
      const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
      window.history.replaceState({}, '', clean)
    } catch { /* ignore */ }

    let stored = null
    try {
      stored = JSON.parse(localStorage.getItem(FLOW_KEY) || 'null')
    } catch { /* ignore */ }
    try { localStorage.removeItem(FLOW_KEY) } catch { /* ignore */ }

    // Ignore a code we didn't initiate (no in-flight flow, or state mismatch).
    if (!stored?.verifier || !stored?.state || stored.state !== state) return false

    try {
      const data = await api.request('/api/v1/feedback/token', {
        method: 'POST',
        body: { code, code_verifier: stored.verifier }
      })
      if (data?.token) {
        auth.setToken(data.token)
        auth.setUser(data.user || null)
      }
    } catch (e) {
      auth.authError = e.message || 'Sign-in failed'
    }
    return true
  }

  function logout() {
    auth.reset()
    submissions.value = []
  }

  async function loadSubmissions() {
    if (!auth.isAuthed || !projectId?.value) {
      submissions.value = []
      return
    }
    submissionsLoading.value = true
    submissionsError.value = ''
    try {
      const rows = await api.request(
        `/api/v1/feedback?project_id=${encodeURIComponent(projectId.value)}`
      )
      submissions.value = Array.isArray(rows) ? rows : []
    } catch (e) {
      submissionsError.value = e.message || 'Failed to load submissions'
    } finally {
      submissionsLoading.value = false
    }
  }

  async function submit(payload, { screenshot = null, attachments = [] } = {}) {
    // Submission is open to anonymous callers — the backend sets
    // submitter_user_id to null when no bearer token is present. Authed users
    // still get their submissions tied to their account.
    if (!projectId?.value) throw new Error('Missing projectId')

    const body = {
      project_id: projectId.value,
      ...payload,
      page_url: window.location.href,
      page_path: window.location.pathname,
      locale: navigator.language,
      referrer: document.referrer,
      client_context: captureClientContext()
    }

    const hasFiles = Boolean(screenshot) || (Array.isArray(attachments) && attachments.length > 0)

    if (hasFiles) {
      const fd = new FormData()
      fd.append('payload', JSON.stringify(body))
      if (screenshot) {
        fd.append('screenshot', screenshot, 'screenshot.png')
      }
      for (const file of attachments) {
        fd.append('attachments', file, file.name)
      }
      await api.request('/api/v1/feedback', { method: 'POST', body: fd })
    } else {
      await api.request('/api/v1/feedback', { method: 'POST', body })
    }
    if (auth.isAuthed) await loadSubmissions()
  }

  // Cross-instance token sync: when another web component on the page logs in/out,
  // mirror that here so both UIs stay in sync without a page reload.
  function bindStorageSync() {
    const handler = (ev) => {
      if (ev.key !== TOKEN_KEY) return
      auth.token = ev.newValue || ''
      if (!ev.newValue) {
        auth.setUser(null)
        submissions.value = []
      } else {
        refreshMe().then(() => auth.isAuthed && loadSubmissions())
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }

  return {
    auth,
    projectId: computed(() => projectId?.value || ''),
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
    firstParty: api.firstParty
  }
}

// --- PKCE helpers (RFC 7636, S256) ---

function base64UrlFromBytes(bytes) {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

// High-entropy base64url token; 32 bytes → 43 chars, a valid PKCE verifier.
function randomUrlToken(byteLen = 32) {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  return base64UrlFromBytes(bytes)
}

async function s256Challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlFromBytes(new Uint8Array(digest))
}

function captureClientContext() {
  const ua = navigator.userAgent || ''
  const uaData = navigator.userAgentData || null
  const isMobile = typeof uaData?.mobile === 'boolean'
    ? uaData.mobile
    : /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    screen: { w: screen.width, h: screen.height },
    dpr: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    color_scheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    connection: navigator.connection?.effectiveType || null,
    query: window.location.search,
    hash: window.location.hash,
    user_agent: ua,
    device_type: isMobile ? 'mobile' : 'desktop',
    is_mobile: isMobile,
    platform: uaData?.platform || detectPlatform(ua),
    browser: detectBrowser(ua),
    ua_brands: Array.isArray(uaData?.brands) ? uaData.brands : null
  }
}

function detectPlatform(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/CrOS/i.test(ua)) return 'ChromeOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return ''
}

function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return 'Edge'
  if (/OPR\/|Opera\//i.test(ua)) return 'Opera'
  if (/Firefox\//i.test(ua)) return 'Firefox'
  if (/Chrome\//i.test(ua)) return 'Chrome'
  if (/Safari\//i.test(ua)) return 'Safari'
  return ''
}
