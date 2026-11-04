// Mounts the feedback web component on every client-side page render.
// No-op when `runtimeConfig.public.feedbackProjectId` is empty — set the
// FEEDBACK_PROJECT_ID env var (or NUXT_PUBLIC_FEEDBACK_PROJECT_ID) in
// dev/.env to a project UUID from /feedback to enable the widget.

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const projectId = (config.public.feedbackProjectId as string | undefined) ?? ''
  if (!projectId) return
  if (typeof window === 'undefined') return

  // Idempotent: rerun-safe across HMR / route changes.
  if (!document.querySelector('script[data-feedback-widget]')) {
    const s = document.createElement('script')
    s.src = '/js/feedback-web-component.iife.js'
    s.async = true
    s.dataset.feedbackWidget = '1'
    document.head.appendChild(s)
  }

  if (document.querySelector('feedback-web-component')) return

  const slot = document.createElement('div')
  slot.className = 'feedback-widget-slot'
  // z-index 40 sits above normal page chrome (~10-30) but below Reka UI's
  // modal/slideover layer (≥50). The third-party-host CSS in slot.css uses
  // a much higher value (~2147483000) because it needs to sit above
  // arbitrary host-page content; in-app we control the stacking context
  // and want modals to cover the chat bubble.
  Object.assign(slot.style, {
    position: 'fixed',
    bottom: '0',
    right: '0',
    zIndex: '40'
  } as Partial<CSSStyleDeclaration>)

  const el = document.createElement('feedback-web-component')
  el.setAttribute('profile-config', JSON.stringify({
    profile: 'chat-bubble',
    projectId,
    apiBase: window.location.origin,
    enabled: true
  }))
  slot.appendChild(el)
  document.body.appendChild(slot)
})
