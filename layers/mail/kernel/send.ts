// One send attempt: resolve the sender, check suppressions and guards, build
// the message, then hand it to the transport. Direct sends and the outbox
// both go through here; the outbox needs the two halves separately so it can
// mark the attempt as started right before the provider call.
import { addressHash } from './address'
import { domainCredentials, suppressionMode, withTimeout, type Kernel } from './context'
import { randomToken } from './crypto'
import { checkEnvAccount } from './env-account'
import { buildMessageHeaders } from './headers'
import { htmlToText, sendViaLog, sendViaSmtp } from './mime'
import { fromDomainOf, resolveSenderRow } from './resolve'
import { activeSuppressions, isSuppressed } from './suppressions'
import type { MailAccountRow, MailDomainRow } from './schema'
import type { Credentials, MailProvider, MailStream, OutgoingMail, ProviderMessage, ProviderSendResult, SendResult } from './types'

const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function validateMail(k: Kernel, m: OutgoingMail): MailStream {
  const stream = k.streams.get(m.stream)
  if (!stream) throw new Error(`Unknown mail stream "${m.stream}"`)
  if (m.ref !== undefined && m.ref !== null && !REF_PATTERN.test(m.ref)) {
    throw new Error('A mail ref may only hold letters, digits, - and _, up to 64 characters')
  }
  if (!m.to || !m.to.includes('@')) throw new Error('A mail needs one recipient address')
  return stream
}

export interface ReadySend {
  kind: 'ready'
  stream: MailStream
  domain: MailDomainRow
  account: MailAccountRow
  provider: MailProvider | null
  credentials: Credentials
  message: Omit<ProviderMessage, 'signal'>
}

export type Prepared =
  | ReadySend
  | { kind: 'final', result: SendResult }
  | { kind: 'hold', reason: 'no_sender' | 'env_pause', result: SendResult }

export async function prepareSend(k: Kernel, m: OutgoingMail): Promise<Prepared> {
  const stream = validateMail(k, m)
  const orgId = m.orgId ?? null

  const sender = await resolveSenderRow(k, stream, orgId)
  if (!sender) {
    return { kind: 'hold', reason: 'no_sender', result: { status: 'no_sender', stream: stream.id } }
  }
  const { domain, account } = sender

  let heldAsBounced = false
  if (stream.userInitiated) {
    const held = await activeSuppressions(k.db, [addressHash(m.to)], orgId)
    heldAsBounced = held.some(r => r.reason === 'hard_bounce')
  } else {
    const hit = await isSuppressed(k.db, m.to, orgId)
    if (hit) return { kind: 'final', result: { status: 'suppressed', reason: hit.reason } }
  }

  for (const guard of k.guards) {
    const verdict = await guard.check(m, { stream, domain: domain.domain, accountId: account.id, accountOrgId: account.org_id })
    if (!verdict.ok) return { kind: 'final', result: { status: 'refused', guard: guard.id, reason: verdict.reason } }
  }

  let provider: MailProvider | null = null
  let credentials: Credentials = {}
  let bypassProviderSuppression = false
  if (k.transport === 'provider') {
    if (!account.provider) {
      return { kind: 'final', result: { status: 'failed', retryable: false, error: 'The sending account has no provider; it can only send under the smtp or log transport' } }
    }
    provider = k.providers.get(account.provider) ?? null
    if (!provider) {
      return { kind: 'final', result: { status: 'failed', retryable: false, error: `Mail provider "${account.provider}" isn't registered in this process` } }
    }
    if (account.source === 'env') {
      if (!k.envAccount && !account.env_fingerprint) {
        return { kind: 'final', result: { status: 'failed', retryable: false, error: 'The env account\'s variables (MAIL_DOMAIN and the provider\'s keys) are no longer set. Set them again, or route this domain\'s streams through another account' } }
      }
      const status = await checkEnvAccount(k)
      if (status !== 'ok') {
        const error = status === 'missing'
          ? 'The env account has no recorded fingerprint yet; the app must boot once before this process sends through it'
          : 'This process\'s mail environment differs from the app\'s; env-account sends are paused until they match'
        return { kind: 'hold', reason: 'env_pause', result: { status: 'failed', retryable: true, error } }
      }
    }
    try {
      credentials = domainCredentials(k, account, domain)
    } catch (err) {
      return { kind: 'final', result: { status: 'failed', retryable: false, error: err instanceof Error ? err.message : String(err) } }
    }
    // Only a mirrored domain gets past the provider's list: elsewhere the
    // provider's list stays in charge.
    bypassProviderSuppression = heldAsBounced && suppressionMode(k, account, domain) === 'mirrored'
    if (bypassProviderSuppression && provider.providerSuppression.release) {
      try {
        await provider.providerSuppression.release(credentials, domain.domain, m.to, 'bounce')
      } catch (err) {
        k.log(`[mail] releasing ${addressHash(m.to).slice(0, 12)} from the provider's bounce list failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  const fromDomain = fromDomainOf(domain)
  const messageId = `<${randomToken(18)}@${fromDomain}>`
  const message: Omit<ProviderMessage, 'signal'> = {
    from: { name: m.fromName ?? null, address: `${m.fromLocal || stream.defaultLocal}@${fromDomain}` },
    domain: domain.domain,
    to: m.to,
    replyTo: m.replyTo ?? null,
    subject: m.subject,
    html: m.html,
    text: m.text ?? htmlToText(m.html),
    messageId,
    headers: buildMessageHeaders(m, messageId),
    attachments: m.attachments ?? [],
    correlation: { stream: stream.id, orgId, ref: m.ref ?? null },
    bypassProviderSuppression
  }
  return { kind: 'ready', stream, domain, account, provider, credentials, message }
}

export async function deliver(k: Kernel, ready: ReadySend): Promise<SendResult> {
  let outcome: ProviderSendResult
  if (k.transport === 'log') {
    outcome = sendViaLog(k.log, { ...ready.message, signal: new AbortController().signal })
  } else if (typeof k.transport === 'object') {
    const { host, port } = k.transport.smtp
    const res = await withTimeout(k.requestTimeoutMs, signal => sendViaSmtp(host, port, { ...ready.message, signal }, k.requestTimeoutMs))
    outcome = res.timedOut ? { status: 'unknown', error: 'The SMTP server didn\'t answer in time' } : res.value
  } else {
    const provider = ready.provider!
    try {
      const res = await withTimeout(k.requestTimeoutMs, signal => provider.send(ready.credentials, { ...ready.message, signal }))
      outcome = res.timedOut ? { status: 'unknown', error: 'The provider didn\'t answer in time' } : res.value
    } catch (err) {
      outcome = { status: 'failed', retryable: true, error: err instanceof Error ? err.message : String(err) }
    }
  }

  if (outcome.status === 'failed' && outcome.keyRejected) {
    await k.db
      .updateTable('mail_domains')
      .set({ send_status: 'failed', send_error: 'key_rejected' })
      .where('id', '=', ready.domain.id)
      .execute()
    return { status: 'failed', retryable: false, error: outcome.error }
  }
  if (outcome.status === 'failed') return { status: 'failed', retryable: outcome.retryable, error: outcome.error }
  if (outcome.status === 'unknown') return outcome
  return {
    status: 'sent',
    accountId: ready.account.id,
    domain: ready.domain.domain,
    providerMessageId: outcome.providerMessageId,
    messageId: outcome.messageId ?? ready.message.messageId
  }
}

// A direct, single attempt. Never call inside a transaction.
export async function sendNow(k: Kernel, m: OutgoingMail): Promise<SendResult> {
  const prepared = await prepareSend(k, m)
  if (prepared.kind !== 'ready') return prepared.result
  return await deliver(k, prepared)
}
