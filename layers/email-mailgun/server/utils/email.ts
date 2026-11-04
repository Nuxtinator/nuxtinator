import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { renderEmailTemplate, type EmailTemplateData } from '#core/server/utils/email-templates'

const isDevelopment = (process.env.NODE_ENV || 'development') === 'development'

let transporter: Transporter | null = null

function getEmailConfig() {
  try {
    const config = useRuntimeConfig()
    return {
      mailgunApiKey: config.mailgunApiKey || process.env.MAILGUN_API_KEY,
      mailgunDomain: config.mailgunDomain || process.env.MAILGUN_DOMAIN,
      mailgunHost: config.mailgunHost || process.env.MAILGUN_HOST,
      smtpFrom: config.smtpFrom || process.env.SMTP_FROM,
      smtpFromName: config.smtpFromName || process.env.SMTP_FROM_NAME,
      appName: config.appName || process.env.APP_NAME
    }
  } catch {
    return {
      mailgunApiKey: process.env.MAILGUN_API_KEY,
      mailgunDomain: process.env.MAILGUN_DOMAIN,
      mailgunHost: process.env.MAILGUN_HOST,
      smtpFrom: process.env.SMTP_FROM,
      smtpFromName: process.env.SMTP_FROM_NAME,
      appName: process.env.APP_NAME
    }
  }
}

// Development preview only: SMTP to MailHog on localhost:1025. Production
// never goes through nodemailer — see sendViaMailgun.
function getDevTransporter(): Transporter {
  if (transporter) return transporter

  console.log('[Email] Using MailHog (development mode)')
  transporter = nodemailer.createTransport({
    host: 'localhost',
    port: 1025,
    secure: false,
    tls: { rejectUnauthorized: false }
  })
  return transporter
}

interface MailgunMessage {
  from: string
  to: string | string[]
  subject: string
  html: string
  text: string
}

// Posts straight to Mailgun's messages API. Talking HTTP directly keeps the
// layer free of a mail-provider SDK and its transitive dependencies; the
// inbox layer sends the same way (layers/apps/inbox/server/utils/inbox-transport.ts).
async function sendViaMailgun(message: MailgunMessage): Promise<string | undefined> {
  const config = getEmailConfig()

  if (!config.mailgunApiKey || !config.mailgunDomain) {
    throw new Error('Mailgun configuration incomplete. Set MAILGUN_API_KEY and MAILGUN_DOMAIN.')
  }

  const host = config.mailgunHost || 'api.mailgun.net'

  const form = new FormData()
  form.append('from', message.from)
  const recipients = Array.isArray(message.to) ? message.to : [message.to]
  for (const recipient of recipients) form.append('to', recipient)
  form.append('subject', message.subject)
  form.append('html', message.html)
  form.append('text', message.text)

  const auth = Buffer.from(`api:${config.mailgunApiKey}`).toString('base64')
  const res = await fetch(`https://${host}/v3/${config.mailgunDomain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Mailgun responded ${res.status}: ${body}`)
  }

  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return json.id
}

export interface EmailOptions {
  to: string | string[]
  subject: string
  html: string
  text?: string
  from?: string
}

export interface TemplateEmailOptions {
  to: string | string[]
  template: keyof typeof import('#core/server/utils/email-templates').emailTemplates
  data: EmailTemplateData
  from?: string
  subject?: string
}

export async function sendEmail(options: EmailOptions): Promise<boolean> {
  try {
    const config = getEmailConfig()

    let fromEmail = options.from
    if (!fromEmail) {
      const fromName = config.smtpFromName || config.appName
      const fromAddress = isDevelopment
        ? 'noreply@localhost.local'
        : (config.smtpFrom || 'noreply@yourdomain.com')
      fromEmail = fromName ? `${fromName} <${fromAddress}>` : fromAddress
    }

    const text = options.text || options.html.replace(/<[^>]*>/g, '')

    if (isDevelopment) {
      const info = await getDevTransporter().sendMail({
        from: fromEmail,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        subject: options.subject,
        html: options.html,
        text
      })
      console.log('[Email] Sent successfully:', info.messageId)
      return true
    }

    const messageId = await sendViaMailgun({
      from: fromEmail,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text
    })
    console.log('[Email] Sent successfully:', messageId)
    return true
  } catch (error) {
    if (!process.env.VITEST) {
      console.error('[Email] Error sending:', error)
    }
    return false
  }
}

export async function sendTemplateEmail(options: TemplateEmailOptions): Promise<boolean> {
  try {
    const config = getEmailConfig()
    const appName = config.appName || 'App'

    const templateData = { ...options.data, appName }
    const { subject, html, text } = renderEmailTemplate(options.template, templateData)

    return await sendEmail({
      to: options.to,
      subject: options.subject || subject,
      html,
      text,
      from: options.from
    })
  } catch (error) {
    if (!process.env.VITEST) {
      console.error('[Email] Error sending template email:', error)
    }
    return false
  }
}

export async function sendBulkTemplateEmails(emails: TemplateEmailOptions[]): Promise<{ success: number, failed: number }> {
  let success = 0
  let failed = 0

  for (const email of emails) {
    const result = await sendTemplateEmail(email)
    if (result) success++
    else failed++
  }

  return { success, failed }
}
