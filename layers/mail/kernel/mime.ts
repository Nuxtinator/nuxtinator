// Building and delivering a fully resolved ProviderMessage outside a
// provider: the raw MIME builder (used by adapters that send raw content),
// the local SMTP catcher transport and the log transport.
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { ProviderMessage, ProviderSendResult } from './types'

function composerOptions(msg: ProviderMessage) {
  const { 'Message-Id': _mid, ...headers } = msg.headers
  return {
    from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
    to: msg.to,
    replyTo: msg.replyTo ?? undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    messageId: msg.messageId,
    headers,
    attachments: msg.attachments.map(a => ({
      filename: a.filename,
      content: a.data,
      contentType: a.contentType,
      ...(a.cid ? { cid: a.cid } : {})
    }))
  }
}

export async function buildMime(msg: ProviderMessage): Promise<Buffer> {
  const composer = new MailComposer(composerOptions(msg))
  return await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err, message) => err ? reject(err) : resolve(message))
  })
}

const smtpTransporters = new Map<string, ReturnType<typeof nodemailer.createTransport>>()

// `timeoutMs` bounds each connection, greeting and socket wait, so a hung
// catcher can't hold a call past the caller's own timeout.
export async function sendViaSmtp(host: string, port: number, msg: ProviderMessage, timeoutMs = 30_000): Promise<ProviderSendResult> {
  const key = `${host}:${port}:${timeoutMs}`
  let transporter = smtpTransporters.get(key)
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      tls: { rejectUnauthorized: false },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs
    })
    smtpTransporters.set(key, transporter)
  }
  try {
    await transporter.sendMail(composerOptions(msg))
    return { status: 'sent', providerMessageId: null, messageId: msg.messageId }
  } catch (err) {
    return { status: 'failed', retryable: true, error: `SMTP: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function sendViaLog(log: (line: string) => void, msg: ProviderMessage): ProviderSendResult {
  log(`[mail] (log transport) ${msg.correlation.stream} from=${msg.from.address} to=${msg.to} subject=${JSON.stringify(msg.subject)} message-id=${msg.messageId}`)
  return { status: 'sent', providerMessageId: null, messageId: msg.messageId }
}

// Plain text from HTML when the caller gave none.
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
