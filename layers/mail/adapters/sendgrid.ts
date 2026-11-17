// SendGrid over its v3 HTTP API (no SDK). Events arrive from the account's
// signed event webhook (ECDSA); inbound arrives from Inbound Parse in raw mode.
import { createHash, createPublicKey, verify as verifySignatureBytes, type KeyObject } from 'node:crypto'
import { parseInbound } from '../kernel/inbound-parse'
import { systemDns } from '../kernel/dns'
import {
  ProviderPermissionError, type Capabilities, type CapabilityKey, type CheckResult, type Credentials, type DnsRecord,
  type MailEvent, type MailEventType, type MailProvider, type ManualStep, type ProviderList, type ProviderSendResult
} from '../kernel/types'
import { baseUrl, EndpointError, formString, lowerHeaders, parseForm } from './http'

const SIGNATURE_SKEW_SECONDS = 15 * 60
const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature'
const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp'
const INBOUND_MX = 'mx.sendgrid.net'

// A capability holds when the key has every scope listed for it.
export const SENDGRID_CAPABILITY_SCOPES: Record<CapabilityKey, string[]> = {
  send: ['mail.send'],
  domains: ['whitelabel.create', 'whitelabel.read', 'whitelabel.update'],
  routes: ['user.webhooks.parse.settings.create', 'user.webhooks.parse.settings.read', 'user.webhooks.parse.settings.update'],
  webhooks: ['user.webhooks.event.settings.read', 'user.webhooks.event.settings.update'],
  suppressionLists: [
    'suppression.bounces.delete', 'suppression.spam_reports.delete', 'asm.suppressions.global.delete',
    'asm.groups.suppressions.read', 'asm.groups.suppressions.delete'
  ]
}

interface SgResult {
  status: number
  ok: boolean
  text: string
  headers: Headers
  json: () => unknown
}

const API_HOST = /^api(\.eu)?\.sendgrid\.com$/

function api(creds: Credentials) {
  return baseUrl(creds.endpoint, 'api.sendgrid.com', API_HOST, 'SendGrid')
}

// The configured endpoint's problem, or null when it's usable.
function endpointProblem(creds: Credentials): string | null {
  try {
    api(creds)
    return null
  } catch (err) {
    if (err instanceof EndpointError) return err.message
    throw err
  }
}

// fetch with a manually cleared timeout (AbortSignal.timeout leaks timers under Bun); keeps the response headers.
async function call(creds: Credentials, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<SgResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${api(creds)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${creds.apiKey ?? ''}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const text = await res.text()
    return {
      status: res.status,
      ok: res.ok,
      text,
      headers: res.headers,
      json: () => {
        try {
          return JSON.parse(text)
        } catch {
          return {}
        }
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function refused(res: SgResult) {
  return res.status === 401 || res.status === 403
}

function fail(res: SgResult, what: string): Error {
  return new Error(`SendGrid ${what} responded ${res.status}: ${res.text.slice(0, 300)}`)
}

function publicKey(key: string): KeyObject {
  if (key.includes('BEGIN PUBLIC KEY')) return createPublicKey(key)
  return createPublicKey({ key: Buffer.from(key.trim(), 'base64'), format: 'der', type: 'spki' })
}

// Returns null when the signature is good, else the reason it isn't.
export function verifySendgridSignature(
  key: string | undefined,
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
  now: number = Date.now()
): string | null {
  if (!key) return 'No webhook verification key is set for this account'
  const h = lowerHeaders(headers)
  const signature = h[SIGNATURE_HEADER]
  const timestamp = h[TIMESTAMP_HEADER]
  if (!signature || !timestamp) return 'Missing signature'
  let ok = false
  try {
    ok = verifySignatureBytes('sha256', Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]), publicKey(key), Buffer.from(signature, 'base64'))
  } catch {
    ok = false
  }
  if (!ok) return 'Invalid signature'
  const ts = Number.parseInt(timestamp, 10)
  if (Number.isNaN(ts) || Math.abs(now / 1000 - ts) > SIGNATURE_SKEW_SECONDS) return 'Stale signature'
  return null
}

const LIST_REASONS: Record<string, ProviderList> = {
  'bounced address': 'bounce',
  'spam reporting address': 'complaint',
  'unsubscribed address': 'unsubscribe',
  'group unsubscribe': 'unsubscribe'
}

// sg_message_id is the send's X-Message-Id followed by `.filter…` parts.
function providerId(sgMessageId: unknown): string | null {
  const id = typeof sgMessageId === 'string' ? sgMessageId : ''
  return id ? id.split('.')[0] || null : null
}

export function mapSendgridEvent(data: Record<string, any>): MailEvent | null {
  const type = String(data.event || '').toLowerCase()
  const reason = String(data.reason || '')
  const base = {
    recipient: String(data.email || '').toLowerCase(),
    providerMessageId: providerId(data.sg_message_id),
    occurredAt: data.timestamp ? new Date(Number(data.timestamp) * 1000) : new Date(),
    detail: (reason || String(data.response || '')) || null,
    stream: data['nx-stream'] ? String(data['nx-stream']) : null,
    orgId: data['nx-org'] ? String(data['nx-org']) : null,
    ref: data['nx-ref'] ? String(data['nx-ref']) : null,
    domain: data['nx-domain'] ? String(data['nx-domain']).toLowerCase() : null,
    permanent: false
  }
  switch (type) {
    case 'delivered': return { ...base, type: 'delivered' }
    case 'bounce':
      return String(data.type || 'bounce').toLowerCase() === 'blocked'
        ? { ...base, type: 'deferred' }
        : { ...base, type: 'bounced', permanent: true }
    case 'deferred': return { ...base, type: 'deferred' }
    case 'dropped': {
      const list = LIST_REASONS[reason.toLowerCase()]
      if (list) return { ...base, type: 'dropped', list, permanent: true }
      return { ...base, type: 'rejected', permanent: reason.toLowerCase() === 'invalid' }
    }
    case 'spamreport': return { ...base, type: 'complained' }
    case 'unsubscribe':
    case 'group_unsubscribe': return { ...base, type: 'unsubscribed' }
    case 'open': return { ...base, type: 'opened' }
    case 'click': return { ...base, type: 'clicked' }
    default: return null
  }
}

// The event webhook's toggles for the kernel's event list.
function eventToggles(events: MailEventType[], delivered: boolean): Record<string, boolean> {
  const on = new Set<string>()
  for (const e of events) {
    if (e === 'bounced') on.add('bounce')
    if (e === 'deferred') on.add('deferred')
    if (e === 'rejected' || e === 'dropped') on.add('dropped')
    if (e === 'complained') on.add('spam_report')
    if (e === 'unsubscribed') {
      on.add('unsubscribe')
      on.add('group_unsubscribe')
    }
    if (e === 'opened') on.add('open')
    if (e === 'clicked') on.add('click')
  }
  if (delivered) on.add('delivered')
  const all = ['delivered', 'bounce', 'deferred', 'dropped', 'spam_report', 'unsubscribe', 'group_unsubscribe', 'group_resubscribe', 'open', 'click', 'processed']
  return Object.fromEntries(all.map(k => [k, on.has(k)]))
}

const TOGGLE_LABELS: Record<string, string> = {
  delivered: 'Delivered',
  bounce: 'Bounced',
  deferred: 'Deferred',
  dropped: 'Dropped',
  spam_report: 'Spam Reports',
  unsubscribe: 'Unsubscribes',
  group_unsubscribe: 'Group Unsubscribes',
  open: 'Opened',
  click: 'Clicked'
}

function mapDns(dns: unknown): DnsRecord[] {
  if (!dns || typeof dns !== 'object') return []
  return Object.entries(dns as Record<string, Record<string, unknown>>).map(([purpose, r]) => ({
    role: 'send' as const,
    type: String(r.type || 'cname').toUpperCase() as DnsRecord['type'],
    name: String(r.host || ''),
    value: String(r.data || ''),
    status: r.valid === true ? 'verified' as const : 'pending' as const,
    purpose
  }))
}

function dkimSelector(records: DnsRecord[]): string | undefined {
  const dkim = records.find(r => /\._domainkey\./.test(r.name))
  return dkim?.name.split('._domainkey.')[0]
}

function receivingMx(domain: string, status: DnsRecord['status'] = 'pending'): DnsRecord[] {
  return [{ role: 'receive', type: 'MX', name: domain, value: INBOUND_MX, priority: 10, status }]
}

async function findAuthenticatedDomain(creds: Credentials, domain: string): Promise<Record<string, unknown> | null> {
  const res = await call(creds, 'GET', `/v3/whitelabel/domains?domain=${encodeURIComponent(domain)}`)
  if (refused(res)) throw new ProviderPermissionError('domains')
  if (!res.ok) throw fail(res, 'domain lookup')
  const list = res.json()
  return Array.isArray(list) ? (list.find((d: Record<string, unknown>) => d.domain === domain) ?? null) : null
}

// The signed webhook's verification key, for accounts whose credential isn't set; cached per key.
const publicKeyCache = new Map<string, { key: string, at: number }>()
async function fetchedPublicKey(creds: Credentials): Promise<string | undefined> {
  if (!creds.apiKey) return undefined
  const cacheKey = createHash('sha256').update(`${api(creds)}\n${creds.apiKey}`).digest('hex')
  const hit = publicKeyCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.key
  const res = await call(creds, 'GET', '/v3/user/webhooks/event/settings/signed')
  const key = res.ok ? (res.json() as { public_key?: string }).public_key : undefined
  if (key) publicKeyCache.set(cacheKey, { key, at: Date.now() })
  return key
}

export const sendgridProvider: MailProvider = {
  id: 'sendgrid',
  label: 'SendGrid',
  credentialFields: [
    { key: 'apiKey', label: 'API key', secret: true, env: 'MAIL_SENDGRID_API_KEY', help: 'Settings → API Keys. Full access, or Mail Send plus the scopes for automatic setup.' },
    { key: 'webhookPublicKey', label: 'Webhook verification key', secret: true, optional: true, env: 'MAIL_SENDGRID_WEBHOOK_PUBLIC_KEY', help: 'Mail Settings → Event Webhook → Signed Event Webhook → Verification Key' },
    { key: 'endpoint', label: 'API endpoint', secret: false, optional: true, help: 'Leave empty for api.sendgrid.com; api.eu.sendgrid.com for EU regional subusers' }
  ],
  supports: { send: true, receive: true, events: true },
  webhookScope: 'account',
  notes: {
    receive: 'Inbound Parse posts are unsigned, so the inbound URL is the only check. Keep it private.'
  },

  async verifyCredentials(creds) {
    if (!creds.apiKey) return { ok: false, error: 'Enter a SendGrid API key' }
    const badEndpoint = endpointProblem(creds)
    if (badEndpoint) return { ok: false, error: badEndpoint }
    const res = await call(creds, 'GET', '/v3/scopes')
    if (refused(res)) return { ok: false, error: 'SendGrid rejected the key' }
    if (!res.ok) return { ok: false, error: `SendGrid responded ${res.status}: ${res.text.slice(0, 200)}` }
    const scopes = new Set((res.json() as { scopes?: string[] }).scopes ?? [])
    const capabilities: Capabilities = {}
    for (const [cap, needed] of Object.entries(SENDGRID_CAPABILITY_SCOPES)) {
      capabilities[cap as CapabilityKey] = needed.every(s => scopes.has(s))
    }
    return { ok: true, capabilities }
  },

  manualSetup(domain, role, urls, { events }): ManualStep[] {
    if (role === 'send') {
      const toggles = eventToggles(events, events.includes('delivered'))
      const ticked = Object.entries(toggles).filter(([, on]) => on).map(([k]) => TOGGLE_LABELS[k] ?? k)
      return [
        { title: `In SendGrid, authenticate the domain ${domain}`, detail: 'Settings → Sender Authentication → Authenticate Your Domain. Add the CNAME records SendGrid shows and verify them.' },
        {
          title: 'Turn on the event webhook',
          detail: `Settings → Mail Settings → Event Webhook. The webhook belongs to the whole SendGrid account, so it serves every domain on it. Post to the URL below and tick only: ${ticked.join(', ')}.${toggles.delivered ? '' : ' Leave "Delivered" unticked.'}`,
          values: [{ label: 'Events URL', value: urls.events }]
        },
        { title: 'Turn on the Signed Event Webhook', detail: 'On the same page, enable signature verification and copy the Verification Key into this account\'s "Webhook verification key" field.' }
      ]
    }
    return [
      { title: `Point the MX record of ${domain} at SendGrid`, detail: `One MX record, priority 10: ${INBOUND_MX}.` },
      {
        title: 'Add an Inbound Parse host',
        detail: `Settings → Inbound Parse → Add Host & URL. Host ${domain}, the URL below, and tick "POST the raw, full MIME message". Inbound Parse posts are unsigned, so the URL is the only secret: don't share it.`,
        values: [{ label: 'Destination URL', value: urls.inboundMime }]
      }
    ]
  },

  async send(creds, msg): Promise<ProviderSendResult> {
    if (!creds.apiKey) return { status: 'failed', retryable: false, error: 'No SendGrid API key', keyRejected: true }
    const badEndpoint = endpointProblem(creds)
    if (badEndpoint) return { status: 'failed', retryable: false, error: badEndpoint }
    // Events don't name the sending domain, so it travels with the correlation values.
    const customArgs: Record<string, string> = { 'nx-stream': msg.correlation.stream, 'nx-domain': msg.domain }
    if (msg.correlation.orgId) customArgs['nx-org'] = msg.correlation.orgId
    if (msg.correlation.ref) customArgs['nx-ref'] = msg.correlation.ref
    const content = [
      ...(msg.text ? [{ type: 'text/plain', value: msg.text }] : []),
      { type: 'text/html', value: msg.html }
    ]
    const body: Record<string, unknown> = {
      personalizations: [{ to: [{ email: msg.to }] }],
      from: msg.from.name ? { email: msg.from.address, name: msg.from.name } : { email: msg.from.address },
      ...(msg.replyTo ? { reply_to: { email: msg.replyTo } } : {}),
      subject: msg.subject,
      content,
      // Includes Message-Id; whether SendGrid delivers it unchanged is not yet confirmed live.
      headers: msg.headers,
      custom_args: customArgs,
      ...(msg.attachments.length
        ? {
            attachments: msg.attachments.map(att => ({
              content: att.data.toString('base64'),
              filename: att.filename,
              type: att.contentType || 'application/octet-stream',
              ...(att.cid ? { disposition: 'inline', content_id: att.cid } : { disposition: 'attachment' })
            }))
          }
        : {}),
      // Skips only the bounce list; bypass_list_management is never used.
      ...(msg.bypassProviderSuppression ? { mail_settings: { bypass_bounce_management: { enable: true } } } : {})
    }
    const res = await call(creds, 'POST', '/v3/mail/send', body, msg.signal)
    if (refused(res)) return { status: 'failed', retryable: false, error: `SendGrid refused the key (${res.status})`, keyRejected: true }
    if (res.status === 429 || res.status >= 500) return { status: 'failed', retryable: true, error: `SendGrid responded ${res.status}` }
    if (!res.ok) return { status: 'failed', retryable: false, error: `SendGrid responded ${res.status}: ${res.text.slice(0, 300)}` }
    return { status: 'sent', providerMessageId: res.headers.get('x-message-id'), messageId: msg.messageId }
  },

  async provisionDomain(creds, domain, role, urls) {
    if (role === 'send') {
      const res = await call(creds, 'POST', '/v3/whitelabel/domains', { domain, automatic_security: true })
      if (refused(res)) throw new ProviderPermissionError('domains')
      let found: Record<string, unknown> | null = res.ok ? res.json() as Record<string, unknown> : null
      const created = !!found
      if (!found) found = await findAuthenticatedDomain(creds, domain)
      if (!found) throw fail(res, 'domain authentication')
      const records = mapDns(found.dns)
      return { records, refs: { domainId: found.id ?? null, created }, dkimSelector: dkimSelector(records) }
    }
    const setting = { hostname: domain, url: urls.inboundMime, send_raw: true, spam_check: true }
    let res = await call(creds, 'POST', '/v3/user/webhooks/parse/settings', setting)
    if (refused(res)) throw new ProviderPermissionError('routes')
    if (!res.ok) {
      res = await call(creds, 'PATCH', `/v3/user/webhooks/parse/settings/${encodeURIComponent(domain)}`, setting)
      if (refused(res)) throw new ProviderPermissionError('routes')
      if (!res.ok) throw fail(res, 'Inbound Parse setting')
    }
    return { records: receivingMx(domain), refs: { parseHostname: domain } }
  },

  async checkDomain(creds, domain, role, refs): Promise<CheckResult> {
    if (role === 'send') {
      const id = refs.domainId ?? (await findAuthenticatedDomain(creds, domain))?.id
      if (!id) return { status: 'failed', records: [], error: 'The domain authentication was deleted at SendGrid' }
      const validate = await call(creds, 'POST', `/v3/whitelabel/domains/${id}/validate`)
      if (refused(validate)) throw new ProviderPermissionError('domains')
      if (validate.status === 404) return { status: 'failed', records: [], error: 'The domain authentication was deleted at SendGrid' }
      const res = await call(creds, 'GET', `/v3/whitelabel/domains/${id}`)
      if (refused(res)) throw new ProviderPermissionError('domains')
      if (!res.ok) throw fail(res, 'domain check')
      const body = res.json() as { valid?: boolean, dns?: unknown }
      return { status: body.valid ? 'verified' : 'pending', records: mapDns(body.dns) }
    }
    const res = await call(creds, 'GET', `/v3/user/webhooks/parse/settings/${encodeURIComponent(String(refs.parseHostname ?? domain))}`)
    if (refused(res)) throw new ProviderPermissionError('routes')
    if (res.status === 404) return { status: 'failed', records: receivingMx(domain), error: 'The Inbound Parse setting was deleted at SendGrid' }
    if (!res.ok) throw fail(res, 'Inbound Parse check')
    // SendGrid doesn't report MX status, so the MX record is looked up directly.
    const mx = await systemDns.mx(domain)
    const pointed = mx.some(r => r.exchange.toLowerCase().replace(/\.$/, '') === INBOUND_MX)
    return { status: pointed ? 'verified' : 'pending', records: receivingMx(domain, pointed ? 'verified' : 'pending') }
  },

  async configureWebhooks(creds, _domain, urls, { delivered, events }) {
    const res = await call(creds, 'PATCH', '/v3/user/webhooks/event/settings', { enabled: true, url: urls.events, ...eventToggles(events, delivered) })
    if (refused(res)) throw new ProviderPermissionError('webhooks')
    if (!res.ok) throw fail(res, 'event webhook')
    const signed = await call(creds, 'PATCH', '/v3/user/webhooks/event/settings/signed', { enabled: true })
    if (refused(signed)) throw new ProviderPermissionError('webhooks')
    if (!signed.ok) throw fail(signed, 'signed event webhook')
    const publicKey = (signed.json() as { public_key?: string }).public_key
    return publicKey ? { credentials: { webhookPublicKey: publicKey } } : undefined
  },

  async deprovisionDomain(creds, _domain, refs) {
    if (refs.parseHostname) await call(creds, 'DELETE', `/v3/user/webhooks/parse/settings/${encodeURIComponent(String(refs.parseHostname))}`)
    if (refs.created && refs.domainId) await call(creds, 'DELETE', `/v3/whitelabel/domains/${refs.domainId}`)
  },

  providerSuppression: {
    mode: caps => caps.suppressionLists ? 'mirrored' : 'unmanaged',
    async release(creds, _domain, address, list) {
      const email = encodeURIComponent(address)
      const path = list === 'bounce'
        ? `/v3/suppression/bounces/${email}`
        : list === 'complaint' ? `/v3/suppression/spam_reports/${email}` : `/v3/asm/suppressions/global/${email}`
      const res = await call(creds, 'DELETE', path)
      if (refused(res)) throw new ProviderPermissionError('suppressionLists')
      if (!res.ok && res.status !== 404) throw fail(res, `${list} release`)
      if (list !== 'unsubscribe') return
      // Unsubscribe groups each keep their own list.
      const groups = await call(creds, 'GET', `/v3/asm/suppressions/${email}`)
      if (refused(groups)) throw new ProviderPermissionError('suppressionLists')
      if (groups.status === 404) return
      if (!groups.ok) throw fail(groups, 'unsubscribe group lookup')
      const listed = ((groups.json() as { suppressions?: { id?: unknown, suppressed?: boolean }[] }).suppressions ?? [])
        .filter(g => g.suppressed && g.id !== undefined && g.id !== null)
      for (const group of listed) {
        const del = await call(creds, 'DELETE', `/v3/asm/groups/${encodeURIComponent(String(group.id))}/suppressions/${email}`)
        if (refused(del)) throw new ProviderPermissionError('suppressionLists')
        if (!del.ok && del.status !== 404) throw fail(del, 'group unsubscribe release')
      }
    }
  },

  async handleWebhook(creds, req) {
    if (req.kind === 'events') {
      const key = creds.webhookPublicKey || await fetchedPublicKey(creds)
      const error = verifySendgridSignature(key, req.headers, req.rawBody)
      if (error) return { type: 'rejected', reason: error }
      let body: unknown
      try {
        body = JSON.parse(req.rawBody.toString('utf8'))
      } catch {
        return { type: 'rejected', reason: 'Malformed payload' }
      }
      if (!Array.isArray(body)) return { type: 'rejected', reason: 'Malformed payload' }
      const events = body.map(e => mapSendgridEvent((e ?? {}) as Record<string, any>)).filter((e): e is MailEvent => !!e)
      return { type: 'events', events }
    }

    // Inbound Parse posts are unsigned: the URL token, checked by the kernel, is the only check.
    const form = await parseForm(req.rawBody, lowerHeaders(req.headers)['content-type'])
    const email = form.get('email')
    const raw = typeof email === 'string' ? Buffer.from(email, 'utf8') : email ? Buffer.from(await email.arrayBuffer()) : null
    if (!raw) return { type: 'rejected', reason: 'Inbound Parse must post the raw MIME message (tick "POST the raw, full MIME message")' }
    let envelope: { to?: unknown, from?: unknown } = {}
    try {
      envelope = JSON.parse(formString(form, 'envelope') || '{}')
    } catch {
      envelope = {}
    }
    const to = Array.isArray(envelope.to) ? envelope.to.map(String) : []
    const mail = await parseInbound(raw, { to, from: typeof envelope.from === 'string' ? envelope.from : null })
    const score = Number.parseFloat(formString(form, 'spam_score'))
    mail.spamScore = Number.isNaN(score) ? null : score
    return { type: 'inbound', mail }
  }
}
