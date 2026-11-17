// Mail transport for the inbox. The `#email` alias is send-only and cannot
// set Reply-To, threading headers, or attachments — all of which
// conversational email needs — so the inbox owns its transport: Mailgun's
// messages API in production, plain SMTP to Mailpit (localhost:1025, UI on
// :8025) in development. The switch is NODE_ENV === 'development', the same
// convention the email-mailgun layer uses (and which dev/vitest.config.ts
// pins through the test build).
import nodemailer from 'nodemailer'
import { inboxHtmlToText } from './inbox-sanitize'

export interface InboxEmailAttachment {
  filename: string
  contentType: string
  data: Buffer
  // When set, the part is embedded inline (Content-ID) rather than attached,
  // and the HTML references it as `cid:<cid>`. For Mailgun the cid must equal
  // the filename, so callers should set filename === cid for inline parts.
  cid?: string
}

export interface InboxEmailOptions {
  from: string // full address, e.g. '"Jane" <contact@example.com>'
  to: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  inReplyTo?: string
  references?: string
  attachments?: InboxEmailAttachment[]
  // RFC 3834: mark this as an automated reply (Auto-Submitted: auto-replied +
  // Precedence: bulk) so other mail servers don't bounce or auto-reply back.
  // Set on the auto-ack / held-sender notices.
  autoReply?: boolean
  // Mailgun v: variables, echoed back verbatim in delivery events — carries
  // org/message correlation to the events webhook. Ignored by SMTP.
  userVariables?: Record<string, string>
}

export interface InboxSendResult {
  success: boolean
  providerMessageId?: string // RFC Message-Id assigned by the provider (with angle brackets)
  error?: string
}

const isDevelopment = process.env.NODE_ENV === 'development'

export async function inboxSendEmail(options: InboxEmailOptions): Promise<InboxSendResult> {
  try {
    if (isDevelopment) {
      return await sendViaSmtp(options)
    }
    return await sendViaMailgun(options)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown send error'
    console.error('[inbox] send failed:', message)
    return { success: false, error: message }
  }
}

async function sendViaSmtp(options: InboxEmailOptions): Promise<InboxSendResult> {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    secure: false,
    tls: { rejectUnauthorized: false }
  })

  const info = await transporter.sendMail({
    from: options.from,
    to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
    subject: options.subject,
    html: options.html,
    text: options.text || inboxHtmlToText(options.html),
    replyTo: options.replyTo,
    inReplyTo: options.inReplyTo,
    references: options.references,
    headers: options.autoReply ? { 'Auto-Submitted': 'auto-replied', 'Precedence': 'bulk' } : undefined,
    attachments: (options.attachments || []).map(a => ({
      filename: a.filename,
      content: a.data,
      contentType: a.contentType,
      ...(a.cid ? { cid: a.cid } : {})
    }))
  })
  return { success: true, providerMessageId: info.messageId }
}

async function sendViaMailgun(options: InboxEmailOptions): Promise<InboxSendResult> {
  const config = useRuntimeConfig()
  const apiKey = String(config.mailgunApiKey || '')
  const domain = String(config.inboxMailgunDomain || config.mailgunDomain || '')
  const host = String(config.mailgunHost || 'api.mailgun.net')
  if (!apiKey || !domain) {
    throw new Error('Mailgun configuration incomplete. Set MAILGUN_API_KEY and MAILGUN_DOMAIN.')
  }

  const form = new FormData()
  form.append('from', options.from)
  const recipients = Array.isArray(options.to) ? options.to : [options.to]
  for (const r of recipients) form.append('to', r)
  form.append('subject', options.subject)
  form.append('html', options.html)
  form.append('text', options.text || inboxHtmlToText(options.html))

  if (options.replyTo) form.append('h:Reply-To', options.replyTo)
  if (options.inReplyTo) form.append('h:In-Reply-To', options.inReplyTo)
  if (options.references) form.append('h:References', options.references)
  if (options.autoReply) {
    form.append('h:Auto-Submitted', 'auto-replied')
    form.append('h:Precedence', 'bulk')
  }
  for (const [key, value] of Object.entries(options.userVariables || {})) {
    form.append(`v:${key}`, value)
  }

  for (const att of options.attachments || []) {
    // Buffer is a valid BlobPart at runtime; the cast satisfies the DOM lib's
    // ArrayBuffer typing. Inline parts (cid set) go in the `inline` field and
    // are referenced as cid:<filename> in the HTML.
    const blob = new Blob([att.data as unknown as BlobPart], { type: att.contentType || 'application/octet-stream' })
    form.append(att.cid ? 'inline' : 'attachment', blob, att.filename)
  }

  const auth = Buffer.from(`api:${apiKey}`).toString('base64')
  const res = await fetch(`https://${host}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Mailgun responded ${res.status}: ${body}`)
  }

  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return { success: true, providerMessageId: json.id }
}
