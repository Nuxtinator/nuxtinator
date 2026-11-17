// Webhook URLs and the request pipeline behind them. The URL token is
// HMAC(webhookSecret, account id + version) and is never stored; bumping the
// account's version rotates its URLs. The token is checked before the
// provider's own signature.
import { accountCredentials, type Kernel } from './context'
import { constantTimeEqual, hmacHex } from './crypto'
import { handleEvents } from './events'
import { dispatchInbound } from './inbound'
import type { MailAccountRow } from './schema'
import type { WebhookUrls } from './types'

export function webhookToken(k: Kernel, account: Pick<MailAccountRow, 'id' | 'webhook_token_version'>): string {
  if (!k.webhookSecret) throw new Error('This mail instance has no webhook secret (set MAIL_WEBHOOK_SECRET or give it the secret key)')
  return hmacHex(k.webhookSecret, `${account.id}:${account.webhook_token_version}`).slice(0, 40)
}

export function webhookUrls(k: Kernel, account: Pick<MailAccountRow, 'id' | 'webhook_token_version'>, baseUrl: string): WebhookUrls {
  const base = `${baseUrl.replace(/\/$/, '')}/api/mail/webhooks/${account.id}/${webhookToken(k, account)}`
  return { events: `${base}/events`, inbound: `${base}/inbound`, inboundMime: `${base}/inbound/mime` }
}

export interface WebhookInput {
  accountId: string
  token: string
  kind: 'events' | 'inbound'
  variant?: string | null
  headers: Record<string, string | undefined>
  rawBody: Buffer
}

export interface WebhookResponse {
  status: number
  body: unknown
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handleWebhook(k: Kernel, input: WebhookInput): Promise<WebhookResponse> {
  if (!UUID.test(input.accountId)) return { status: 404, body: { error: 'Not found' } }
  const account = await k.db.selectFrom('mail_accounts').selectAll().where('id', '=', input.accountId).executeTakeFirst()
  if (!account || !constantTimeEqual(webhookToken(k, account), input.token)) {
    return { status: 404, body: { error: 'Not found' } }
  }
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  if (!provider) return { status: 404, body: { error: 'Not found' } }

  const result = await provider.handleWebhook(accountCredentials(k, account), {
    kind: input.kind,
    variant: input.variant ?? null,
    headers: input.headers,
    rawBody: input.rawBody,
    account
  })

  if (result.type === 'rejected') return { status: 401, body: { error: result.reason } }
  if (result.type === 'handshake') return { status: 200, body: result.response ?? { status: 'ok' } }

  if (result.type === 'events') {
    if (input.kind !== 'events') return { status: 400, body: { error: 'Events posted to the inbound URL' } }
    try {
      await handleEvents(k, account, result.events)
    } catch (err) {
      k.log(`[mail] event handling failed: ${err instanceof Error ? err.message : err}`)
      return { status: 503, body: { error: 'Temporary failure, please retry' } }
    }
    return { status: 200, body: { status: 'ok', events: result.events.length } }
  }

  if (input.kind !== 'inbound') return { status: 400, body: { error: 'Inbound mail posted to the events URL' } }
  try {
    const dispatched = await dispatchInbound(k, account, result.mail)
    if (dispatched.outcome === 'retry') return { status: 503, body: { error: 'Temporary failure, please retry' } }
    return { status: 200, body: { status: dispatched.outcome, recipients: dispatched.recipients } }
  } catch (err) {
    k.log(`[mail] inbound dispatch failed: ${err instanceof Error ? err.message : err}`)
    return { status: 503, body: { error: 'Temporary failure, please retry' } }
  }
}
