// Core's `#email` implementation: renders core's templates and sends them
// through the mail kernel. Mail the person just asked for (password reset,
// verification) goes on the `account` stream, which skips suppressions;
// everything else goes on `system`. Returns true when the mail was sent or
// queued for a retry.
//
// Lives outside `server/utils/` so Nuxt's auto-imports don't double up on it.
// `modules/email-kernel.ts` points the `#email` alias here unless another
// layer has set it.
import { renderEmailTemplate, type EmailTemplateData, type emailTemplates } from '../server/utils/email-templates'
import { sendMail } from '../server/utils/mail'

export interface EmailOptions {
  to: string | string[]
  subject: string
  html: string
  text?: string
  // A display name and local part; the domain always comes from the stream's sending domain.
  from?: string
  stream?: string
  expiresInMinutes?: number
}

export interface TemplateEmailOptions {
  to: string | string[]
  template: keyof typeof emailTemplates
  data: EmailTemplateData
  from?: string
  subject?: string
}

const ACCOUNT_TEMPLATES = new Set<TemplateEmailOptions['template']>(['passwordReset', 'verification', 'emailChangeVerification'])

// Reset links last an hour, so the mail mustn't arrive late.
const EXPIRY_MINUTES: Partial<Record<TemplateEmailOptions['template'], number>> = { passwordReset: 50 }

export function streamForTemplate(template: TemplateEmailOptions['template']): 'account' | 'system' {
  return ACCOUNT_TEMPLATES.has(template) ? 'account' : 'system'
}

function appName(): string {
  try {
    return String(useRuntimeConfig().appName || process.env.APP_NAME || '')
  } catch {
    return process.env.APP_NAME || ''
  }
}

function parseFrom(from: string | undefined): { name?: string, local?: string } {
  if (!from) return {}
  const angle = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  const address = (angle ? angle[2]! : from).trim()
  const at = address.lastIndexOf('@')
  return { name: angle?.[1]?.trim() || undefined, local: at > 0 ? address.slice(0, at) : undefined }
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const recipients = Array.isArray(options.to) ? options.to : [options.to]
  const from = parseFrom(options.from)
  const fromName = from.name || process.env.SMTP_FROM_NAME || appName() || undefined
  let ok = recipients.length > 0
  for (const to of recipients) {
    try {
      const res = await sendMail({
        stream: options.stream ?? 'system',
        to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        fromName,
        fromLocal: from.local,
        expiresInMinutes: options.expiresInMinutes
      })
      if (res.status !== 'sent' && res.status !== 'queued') {
        ok = false
        if (!process.env.VITEST) console.warn(`[email] not sent (${res.status}${'error' in res ? `: ${res.error}` : 'reason' in res ? `: ${res.reason}` : ''})`)
      }
    } catch (error) {
      ok = false
      if (!process.env.VITEST) console.error('[email] error sending:', error)
    }
  }
  return ok
}

export async function sendTemplateEmail(options: TemplateEmailOptions): Promise<boolean> {
  try {
    const { subject, html, text } = renderEmailTemplate(options.template, { ...options.data, appName: appName() || 'App' })
    return await sendEmail({
      to: options.to,
      subject: options.subject || subject,
      html,
      text,
      from: options.from,
      stream: streamForTemplate(options.template),
      expiresInMinutes: EXPIRY_MINUTES[options.template]
    })
  } catch (error) {
    if (!process.env.VITEST) console.error('[email] error sending template email:', error)
    return false
  }
}

export async function sendBulkTemplateEmails(emails: TemplateEmailOptions[]): Promise<{ success: number, failed: number }> {
  let success = 0
  let failed = 0
  for (const email of emails) {
    if (await sendTemplateEmail(email)) success++
    else failed++
  }
  return { success, failed }
}
