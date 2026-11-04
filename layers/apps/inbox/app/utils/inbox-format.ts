// Client-side display helpers shared by the inbox components.
import DOMPurify from 'dompurify'

// Sanitize inbound HTML before v-html. The server sanitizes email SINKS
// (outbound mail); the browser view is its own sink and sanitizes here.
export function inboxSanitizeDisplayHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['srcset']
  })
}

// Human-readable message for a failed $fetch call. The server's declared
// statusMessage (intentional wording — e.g. "File exceeds 25 MB", "File type
// not allowed") beats ofetch's composed message; both beat a blank toast.
export function inboxErrorMessage(err: unknown): string | undefined {
  const e = err as { data?: { statusMessage?: string }, statusMessage?: string } | null
  return e?.data?.statusMessage
    || e?.statusMessage
    || (err instanceof Error ? err.message : undefined)
}

export function inboxRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return ''
  const then = new Date(value).getTime()
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

export const INBOX_STATUS_META: Record<string, { label: string, color: 'primary' | 'warning' | 'neutral' | 'error' | 'success' }> = {
  open: { label: 'Open', color: 'primary' },
  pending: { label: 'Pending', color: 'warning' },
  closed: { label: 'Closed', color: 'neutral' },
  spam: { label: 'Spam', color: 'error' }
}

// The deliverability suppression vocabulary as badge labels (why an address
// is not receiving mail).
export const INBOX_SUPPRESSION_REASON_META: Record<string, { label: string, color: 'error' | 'warning' | 'neutral' }> = {
  hard_bounce: { label: 'Hard bounce', color: 'error' },
  complaint: { label: 'Complaint', color: 'error' },
  manual: { label: 'Manual block', color: 'warning' }
}

// How a conversation entered the inbox. Rendered as a small muted badge on
// list rows so staff can tell an emailed thread from a form submission or a
// staff-composed one at a glance.
export const INBOX_SOURCE_META: Record<string, { label: string, icon: string }> = {
  inbound_email: { label: 'Email', icon: 'i-lucide-mail' },
  contact_form: { label: 'Form', icon: 'i-lucide-clipboard-list' },
  helpinator: { label: 'Chat', icon: 'i-lucide-message-circle' },
  staff: { label: 'Staff', icon: 'i-lucide-pen-line' }
}

// The dot colour for a tag folder/chip. Tag colours are Nuxt UI theme colours,
// so a chip renders directly as <UBadge :color>; a plain dot uses the matching
// semantic CSS variable. Inline style (not a Tailwind class) so the value can
// vary per tag without a dynamic-class purge. Neutral has no --ui-neutral
// alias; fall back to a muted foreground.
export function inboxTagDotColor(color: string): string {
  return color === 'neutral' ? 'var(--ui-text-dimmed)' : `var(--ui-${color})`
}
