import type { OutgoingMail } from './types'

// The headers every message carries beyond From/To/Subject/Reply-To.
export function buildMessageHeaders(m: OutgoingMail, messageId: string): Record<string, string> {
  const headers: Record<string, string> = { ...(m.headers ?? {}), 'Message-Id': messageId }
  if (m.inReplyTo) headers['In-Reply-To'] = m.inReplyTo
  if (m.references) headers['References'] = m.references
  if (m.unsubscribeUrl) {
    // RFC 8058 one-click unsubscribe.
    headers['List-Unsubscribe'] = `<${m.unsubscribeUrl}>`
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  if (m.autoReply) {
    // RFC 3834: an automated reply, so other servers don't auto-reply back.
    headers['Auto-Submitted'] = 'auto-replied'
    headers['Precedence'] = 'bulk'
  }
  return headers
}
