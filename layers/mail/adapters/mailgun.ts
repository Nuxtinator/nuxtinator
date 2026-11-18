// Mailgun over its HTTP API (no SDK). Sending uses the domain sending key
// when the domain has one, else the account API key. Inbound arrives as raw
// MIME (`body-mime`) from a route that forwards to the /inbound/mime URL;
// events arrive as signed JSON webhooks.
import { createHmac } from 'node:crypto'
import { constantTimeEqual } from '../kernel/crypto'
import { parseInbound } from '../kernel/inbound-parse'
import { PROBE_STREAM } from '../kernel/events'
import {
  ProviderPermissionError, type Capabilities, type CheckResult, type Credentials, type DnsRecord, type DomainInspection, type MailEvent,
  type MailEventType, type MailProvider, type ManualStep, type ProviderList, type ProviderSendResult
} from '../kernel/types'
import { basicAuth, baseUrl, EndpointError, formString, lowerHeaders, parseForm, request, type HttpResult } from './http'

const SIGNATURE_SKEW_SECONDS = 15 * 60

const API_HOST = /^api(\.eu)?\.mailgun\.net$/

function api(creds: Credentials) {
  return baseUrl(creds.host, 'api.mailgun.net', API_HOST, 'Mailgun')
}

// The configured host's problem, or null when it's usable.
function endpointProblem(creds: Credentials): string | null {
  try {
    api(creds)
    return null
  } catch (err) {
    if (err instanceof EndpointError) return err.message
    throw err
  }
}

function isEu(creds: Credentials) {
  return (creds.host || '').includes('.eu.')
}

async function call(creds: Credentials, key: string | undefined, method: string, path: string, body?: FormData | URLSearchParams, signal?: AbortSignal): Promise<HttpResult> {
  return await request(`${api(creds)}${path}`, {
    method,
    headers: key ? { Authorization: basicAuth('api', key) } : {},
    body,
    signal
  })
}

function refused(res: HttpResult) {
  return res.status === 401 || res.status === 403
}

function fail(res: HttpResult, what: string): Error {
  return new Error(`Mailgun ${what} responded ${res.status}: ${res.text.slice(0, 300)}`)
}

function verifySignature(signingKey: string | undefined, sig: { timestamp?: string, token?: string, signature?: string }): string | null {
  if (!signingKey) return 'No webhook signing key is set for this account'
  if (!sig.timestamp || !sig.token || !sig.signature) return 'Missing signature'
  const expected = createHmac('sha256', signingKey).update(sig.timestamp + sig.token).digest('hex')
  if (!constantTimeEqual(expected, sig.signature)) return 'Invalid signature'
  const ts = Number.parseInt(sig.timestamp, 10)
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_SKEW_SECONDS) return 'Stale signature'
  return null
}

const LIST_REASONS: Record<string, ProviderList> = {
  'suppress-bounce': 'bounce',
  'suppress-complaint': 'complaint',
  'suppress-unsubscribe': 'unsubscribe'
}

export function mapMailgunEvent(data: Record<string, any>): MailEvent | null {
  const type = String(data.event || '').toLowerCase()
  const severity = String(data.severity || '').toLowerCase()
  const vars = (data['user-variables'] ?? {}) as Record<string, string>
  const status = (data['delivery-status'] ?? {}) as Record<string, unknown>
  const detail = String(status.message || status.description || data.reason || '') || null
  const sender = String(data.envelope?.sender || '')
  const base = {
    recipient: String(data.recipient || ''),
    providerMessageId: data.message?.headers?.['message-id'] ? String(data.message.headers['message-id']) : null,
    occurredAt: data.timestamp ? new Date(Number(data.timestamp) * 1000) : new Date(),
    detail,
    stream: vars['nx-stream'] || null,
    orgId: vars['nx-org'] || null,
    ref: vars['nx-ref'] || null,
    domain: sender.includes('@') ? sender.slice(sender.lastIndexOf('@') + 1).toLowerCase() : null,
    permanent: false
  }
  switch (type) {
    case 'delivered': return { ...base, type: 'delivered' }
    case 'failed': {
      const list = LIST_REASONS[String(data.reason || '').toLowerCase()]
      if (list) return { ...base, type: 'dropped', list, permanent: true }
      return severity === 'permanent' ? { ...base, type: 'bounced', permanent: true } : { ...base, type: 'deferred' }
    }
    case 'permanent_fail':
    case 'bounced': return { ...base, type: 'bounced', permanent: true }
    case 'temporary_fail': return { ...base, type: 'deferred' }
    case 'rejected': return { ...base, type: 'rejected', permanent: true }
    case 'complained': return { ...base, type: 'complained' }
    case 'unsubscribed': return { ...base, type: 'unsubscribed' }
    case 'opened': return { ...base, type: 'opened' }
    case 'clicked': return { ...base, type: 'clicked' }
    default: return null
  }
}

// Mailgun's webhook kinds for the kernel's event list.
function webhookKinds(events: MailEventType[]): string[] {
  const kinds = new Set<string>()
  for (const e of events) {
    if (e === 'delivered') kinds.add('delivered')
    if (e === 'bounced' || e === 'rejected' || e === 'dropped') kinds.add('permanent_fail')
    if (e === 'deferred') kinds.add('temporary_fail')
    if (e === 'complained') kinds.add('complained')
    if (e === 'unsubscribed') kinds.add('unsubscribed')
    if (e === 'opened') kinds.add('opened')
    if (e === 'clicked') kinds.add('clicked')
  }
  return [...kinds]
}

// The event names Mailgun's Webhooks page shows for each kind.
const KIND_LABELS: Record<string, string> = {
  delivered: 'Delivered messages',
  permanent_fail: 'Permanent failure',
  temporary_fail: 'Temporary failure',
  complained: 'Spam complaints',
  unsubscribed: 'Unsubscribes',
  opened: 'Opens',
  clicked: 'Clicks'
}

// Addresses of this app's own webhooks: the kernel's, and the inbox's before it.
const OWN_WEBHOOK = /\/api\/mail\/webhooks\/|\/api\/inbox\/webhooks\/mailgun\//

const ALL_KINDS = ['delivered', 'permanent_fail', 'temporary_fail', 'complained', 'unsubscribed', 'opened', 'clicked']

function sendKey(creds: Credentials): string | undefined {
  return creds.sendingKey || creds.apiKey
}

function mapDnsRecords(role: 'send' | 'receive', list: unknown): DnsRecord[] {
  if (!Array.isArray(list)) return []
  return list.map((r: Record<string, unknown>) => ({
    role,
    type: String(r.record_type || 'TXT').toUpperCase() as DnsRecord['type'],
    name: String(r.name || ''),
    value: String(r.value || ''),
    ...(r.priority ? { priority: Number(r.priority) } : {}),
    status: r.valid === 'valid' ? 'verified' as const : r.valid === 'invalid' ? 'failed' as const : 'pending' as const
  }))
}

function receivingMx(creds: Credentials, domain: string): DnsRecord[] {
  const prefix = isEu(creds) ? 'eu.' : ''
  return [
    { role: 'receive', type: 'MX', name: domain, value: `mxa.${prefix}mailgun.org`, priority: 10, status: 'pending' },
    { role: 'receive', type: 'MX', name: domain, value: `mxb.${prefix}mailgun.org`, priority: 10, status: 'pending' }
  ]
}

function dkimSelector(records: DnsRecord[]): string | undefined {
  const dkim = records.find(r => /\._domainkey\./.test(r.name))
  return dkim?.name.split('._domainkey.')[0]
}

export const mailgunProvider: MailProvider = {
  id: 'mailgun',
  label: 'Mailgun',
  credentialFields: [
    { key: 'apiKey', label: 'Account API key', secret: true, optional: true, env: 'MAILGUN_API_KEY', help: 'Only if you use one key for every domain instead of a sending key per domain. Settings → API Keys. An Admin key also lets the app set domains up for you.', advanced: true },
    { key: 'host', label: 'API host', secret: false, optional: true, env: 'MAILGUN_HOST', help: 'api.eu.mailgun.net for the EU region' },
    { key: 'webhookSigningKey', label: 'Webhook signing key', secret: true, optional: true, env: 'MAILGUN_WEBHOOK_SIGNING_KEY', help: 'Sending → Webhooks → HTTP webhook signing key. Read automatically from an Admin key.', forWebhooks: true }
  ],
  domainCredentialFields: [
    { key: 'sendingKey', label: 'Sending key', secret: true, optional: true, help: 'In Mailgun, open the domain → Domain settings → Sending API keys → Add sending key. It sends only for this domain.' }
  ],
  supports: { send: true, receive: true, events: true },
  webhookScope: 'domain',
  receivesAt: exchange => /^mx[ab]\.(eu\.)?mailgun\.org$/.test(exchange),

  async verifyCredentials(creds, domain, opts) {
    const caps: Capabilities = {}
    const badHost = endpointProblem(creds)
    if (badHost) return { ok: false, error: badHost }
    const key = sendKey(creds)
    if (!key) {
      if (creds.webhookSigningKey) return { ok: true, capabilities: caps }
      return { ok: false, error: 'Enter an API key, or a sending key on each domain' }
    }

    // The account key is probed even beside a domain sending key: the domain
    // still uses it for everything but sending.
    let accountKeyWorks = false
    let issued: Credentials | undefined
    if (creds.apiKey) {
      const res = await call(creds, creds.apiKey, 'GET', '/v4/domains?limit=1')
      if (res.ok) accountKeyWorks = true
      else if (!refused(res)) return { ok: false, error: `Mailgun responded ${res.status}`, retryable: res.status === 429 || res.status >= 500 }
    }
    if (accountKeyWorks) {
      // Only an Admin key may read the signing key, and only an Admin key may change domains, routes and webhooks.
      const signing = await call(creds, creds.apiKey, 'GET', '/v5/accounts/http_signing_key')
      if (signing.ok) {
        Object.assign(caps, { domains: true, routes: true, webhooks: true })
        const value = (signing.json() as { http_signing_key?: string }).http_signing_key
        if (value) issued = { webhookSigningKey: value }
      } else if (refused(signing)) {
        Object.assign(caps, { domains: false, routes: false, webhooks: false })
      }
    }

    if (domain) {
      const form = new FormData()
      form.append('from', `postmaster@${domain}`)
      form.append('to', opts?.probeAddress || `nx-probe-verify@${domain}`)
      form.append('subject', 'Credential check')
      form.append('text', 'Credential check (test mode, not delivered).')
      form.append('o:testmode', 'yes')
      form.append('v:nx-stream', PROBE_STREAM)
      form.append('o:suppress-headers', 'X-Mailgun-Variables')
      const res = await call(creds, key, 'POST', `/v3/${domain}/messages`, form)
      if (res.ok) caps.send = true
      else if (refused(res)) caps.send = false
      else return { ok: false, error: `Mailgun test send responded ${res.status}: ${res.text.slice(0, 200)}`, retryable: res.status === 429 || res.status >= 500 }

      if (accountKeyWorks) {
        // No role can read a suppression list without being able to change it.
        const probe = await call(creds, creds.apiKey, 'GET', `/v3/${domain}/bounces/${encodeURIComponent(`nx-probe-none-${Date.now()}@${domain}`)}`)
        if (probe.ok || probe.status === 404) caps.suppressionLists = true
        else if (refused(probe)) caps.suppressionLists = false
      }
    }

    if (!accountKeyWorks) {
      if (caps.send !== true) return { ok: false, error: 'Mailgun rejected the key' }
      // Only a domain sending key works: it can send and nothing else.
      Object.assign(caps, { domains: false, routes: false, webhooks: false, suppressionLists: false })
    }
    return { ok: true, capabilities: caps, ...(issued ? { credentials: issued } : {}) }
  },

  manualSetup(domain, role, urls, { events }): ManualStep[] {
    if (role === 'send') {
      const kinds = webhookKinds(events)
      return [
        { title: `Add ${domain} in Mailgun`, detail: 'Send → Sending → Domains → Add new domain, in the region that matches the API host here. Skip this if it is already there.', check: 'provider-domain' },
        { title: 'Add the DNS records Mailgun shows', detail: 'Add each record at your DNS host, then press Verify in Mailgun. They are listed here too once Mailgun has the domain.', check: 'provider-dns' },
        {
          title: 'Send its events here',
          detail: `Send → Sending → Webhooks, with ${domain} picked at the top. For each event, Add webhook, choose the event and paste the URL: ${kinds.map(k => KIND_LABELS[k] ?? k).join(', ')}.${kinds.includes('delivered') ? '' : ' Delivered messages isn\'t needed.'} Delete webhooks that still point at an old address of this app.`,
          values: [{ label: 'Events URL', value: urls.events }],
          check: 'webhooks'
        },
        { title: 'Save the webhook signing key here', detail: 'It is on the same Webhooks page, under HTTP webhook signing key. Paste it into this domain\'s account under Email → Accounts.', check: 'credential:webhookSigningKey' }
      ]
    }
    return [
      { title: `Point the MX records of ${domain} at Mailgun`, detail: 'At your DNS host, two MX records with priority 10: mxa.mailgun.org and mxb.mailgun.org (mxa.eu.mailgun.org and mxb.eu.mailgun.org in the EU region).', check: 'mx' },
      {
        title: 'Forward its mail here with a route',
        detail: 'Receive → Routes → Create route. Expression type: Match recipient, with the recipient below. Tick Forward and paste the URL below, and tick Stop. Leave the priority at 0 and save.',
        values: [{ label: 'Recipient', value: `*@${domain}` }, { label: 'Forward URL', value: urls.inboundMime }],
        check: 'route'
      },
      { title: 'Verify receiving', detail: 'Press Verify receiving once the steps above are done: a probe message goes to the domain, and receiving is verified when it arrives here.', check: 'probe' }
    ]
  },

  async inspectDomain(creds, domain, urls, { events, receive }): Promise<DomainInspection> {
    const seen: DomainInspection = { domain: null, webhooks: null, route: null }
    // A domain's sending key can read its setup too.
    const key = creds.apiKey || creds.sendingKey
    if (!key || endpointProblem(creds)) return seen
    const d = await call(creds, key, 'GET', `/v4/domains/${domain}`)
    if (d.status === 404) seen.domain = { exists: false, records: [] }
    else if (d.ok) {
      const body = d.json() as { sending_dns_records?: unknown }
      seen.domain = { exists: true, records: [...mapDnsRecords('send', body.sending_dns_records), ...(receive ? receivingMx(creds, domain) : [])] }
    }
    if (seen.domain?.exists) {
      const w = await call(creds, key, 'GET', `/v3/domains/${domain}/webhooks`)
      if (w.ok) {
        const current = (w.json() as { webhooks?: Record<string, { urls?: string[] }> }).webhooks ?? {}
        const has = (kind: string) => (current[kind]?.urls ?? []).includes(urls.events)
        const missing = webhookKinds(events).filter(kind => !has(kind)).map(kind => KIND_LABELS[kind] ?? kind)
        const stale = [...new Set(Object.values(current).flatMap(v => v.urls ?? []).filter(u => u !== urls.events && OWN_WEBHOOK.test(u)))]
        seen.webhooks = { missing, stale }
      }
    }
    if (receive) {
      const r = await call(creds, key, 'GET', '/v3/routes?limit=1000')
      if (r.ok) {
        const routes = ((r.json() as { items?: { description?: string, expression?: string, actions?: string[], priority?: number }[] }).items) ?? []
        // Typed by hand the domain's dots may or may not be escaped.
        const mentions = (x: { expression?: string }) => [domain, domain.replace(/\./g, '\\.')].some(name => (x.expression ?? '').includes(name))
        const ours = routes.filter(x => (x.actions ?? []).some(a => a.includes(urls.inboundMime)) && mentions(x))
        const best = Math.min(...ours.map(x => x.priority ?? 0))
        // A route for the same recipients that stops first keeps the mail from reaching ours.
        const conflict = routes.find(x => !ours.includes(x)
          && mentions(x)
          && (x.actions ?? []).some(a => a.startsWith('stop'))
          && (!ours.length || (x.priority ?? 0) <= best))
        seen.route = { ok: ours.length > 0 && !conflict, ...(conflict ? { conflict: conflict.description || conflict.expression } : {}) }
      }
    }
    return seen
  },

  async send(creds, msg): Promise<ProviderSendResult> {
    const key = sendKey(creds)
    if (!key) return { status: 'failed', retryable: false, error: 'No Mailgun key for this domain', keyRejected: true }
    const badHost = endpointProblem(creds)
    if (badHost) return { status: 'failed', retryable: false, error: badHost }
    const form = new FormData()
    form.append('from', msg.from.name ? `"${msg.from.name.replace(/"/g, '\'')}" <${msg.from.address}>` : msg.from.address)
    form.append('to', msg.to)
    form.append('subject', msg.subject)
    form.append('html', msg.html)
    form.append('text', msg.text)
    if (msg.replyTo) form.append('h:Reply-To', msg.replyTo)
    for (const [name, value] of Object.entries(msg.headers)) form.append(`h:${name}`, value)
    form.append('v:nx-stream', msg.correlation.stream)
    if (msg.correlation.orgId) form.append('v:nx-org', msg.correlation.orgId)
    if (msg.correlation.ref) form.append('v:nx-ref', msg.correlation.ref)
    // Recipients don't see the org and message ids.
    form.append('o:suppress-headers', 'X-Mailgun-Variables')
    for (const att of msg.attachments) {
      const blob = new Blob([new Uint8Array(att.data)], { type: att.contentType || 'application/octet-stream' })
      // Mailgun uses the filename as an inline part's Content-ID.
      form.append(att.cid ? 'inline' : 'attachment', blob, att.cid || att.filename)
    }
    const res = await call(creds, key, 'POST', `/v3/${msg.domain}/messages`, form, msg.signal)
    if (refused(res)) return { status: 'failed', retryable: false, error: `Mailgun refused the key (${res.status})`, keyRejected: true }
    if (res.status === 429 || res.status >= 500) return { status: 'failed', retryable: true, error: `Mailgun responded ${res.status}` }
    if (!res.ok) return { status: 'failed', retryable: false, error: `Mailgun responded ${res.status}: ${res.text.slice(0, 300)}` }
    const id = (res.json() as { id?: string }).id ?? null
    return { status: 'sent', providerMessageId: id, messageId: msg.messageId }
  },

  async provisionDomain(creds, domain, role, urls) {
    if (role === 'send') {
      const form = new URLSearchParams({ name: domain })
      let res = await call(creds, creds.apiKey, 'POST', '/v4/domains', form)
      if (refused(res)) throw new ProviderPermissionError('domains')
      let created = res.ok
      if (!res.ok) {
        res = await call(creds, creds.apiKey, 'GET', `/v4/domains/${domain}`)
        if (refused(res)) throw new ProviderPermissionError('domains')
        if (!res.ok) throw fail(res, 'domain create')
        created = false
      }
      const body = res.json() as { sending_dns_records?: unknown }
      const records = mapDnsRecords('send', body.sending_dns_records)
      return { records, refs: { created }, dkimSelector: dkimSelector(records) }
    }
    const form = new URLSearchParams()
    form.append('priority', '0')
    form.append('description', `nuxtinator ${domain}`)
    form.append('expression', `match_recipient(".*@${domain.replace(/\./g, '\\.')}")`)
    form.append('action', `forward("${urls.inboundMime}")`)
    form.append('action', 'stop()')
    const res = await call(creds, creds.apiKey, 'POST', '/v3/routes', form)
    if (refused(res)) throw new ProviderPermissionError('routes')
    if (!res.ok) throw fail(res, 'route create')
    const route = (res.json() as { route?: { id?: string } }).route
    return { records: receivingMx(creds, domain), refs: { routeId: route?.id ?? null } }
  },

  async checkDomain(creds, domain, role, refs): Promise<CheckResult> {
    if (role === 'send') {
      await call(creds, creds.apiKey, 'PUT', `/v4/domains/${domain}/verify`)
      const res = await call(creds, creds.apiKey, 'GET', `/v4/domains/${domain}`)
      if (refused(res)) throw new ProviderPermissionError('domains')
      if (!res.ok) throw fail(res, 'domain check')
      const body = res.json() as { domain?: { state?: string }, sending_dns_records?: unknown }
      const records = mapDnsRecords('send', body.sending_dns_records)
      const status = body.domain?.state === 'active' ? 'verified' : records.some(r => r.status === 'failed') ? 'failed' : 'pending'
      return { status, records }
    }
    const res = await call(creds, creds.apiKey, 'GET', `/v4/domains/${domain}`)
    const body = res.ok ? res.json() as { receiving_dns_records?: unknown } : {}
    const records = res.ok ? mapDnsRecords('receive', body.receiving_dns_records) : receivingMx(creds, domain)
    if (refs.routeId) {
      const route = await call(creds, creds.apiKey, 'GET', `/v3/routes/${refs.routeId}`)
      if (route.status === 404) return { status: 'failed', records, error: 'The receiving route was deleted at Mailgun' }
    }
    const status = records.length > 0 && records.every(r => r.status === 'verified') ? 'verified' : 'pending'
    return { status, records }
  },

  async configureWebhooks(creds, domain, urls, { events }) {
    const wanted = new Set(webhookKinds(events))
    const existing = await call(creds, creds.apiKey, 'GET', `/v3/domains/${domain}/webhooks`)
    if (refused(existing)) throw new ProviderPermissionError('webhooks')
    const current = (existing.json() as { webhooks?: Record<string, { urls?: string[] }> }).webhooks ?? {}
    for (const kind of ALL_KINDS) {
      const urlsNow = current[kind]?.urls ?? []
      if (wanted.has(kind)) {
        if (urlsNow.includes(urls.events)) continue
        const form = new URLSearchParams()
        for (const u of urlsNow.filter(u => !u.includes('/api/mail/webhooks/'))) form.append('url', u)
        form.append('url', urls.events)
        let res = urlsNow.length
          ? await call(creds, creds.apiKey, 'PUT', `/v3/domains/${domain}/webhooks/${kind}`, form)
          : null
        if (!res || res.status === 404) {
          form.append('id', kind)
          res = await call(creds, creds.apiKey, 'POST', `/v3/domains/${domain}/webhooks`, form)
        }
        if (refused(res)) throw new ProviderPermissionError('webhooks')
        if (!res.ok) throw fail(res, `webhook ${kind}`)
      } else if (urlsNow.includes(urls.events)) {
        const rest = urlsNow.filter(u => u !== urls.events)
        const res = rest.length
          ? await call(creds, creds.apiKey, 'PUT', `/v3/domains/${domain}/webhooks/${kind}`, new URLSearchParams(rest.map(u => ['url', u])))
          : await call(creds, creds.apiKey, 'DELETE', `/v3/domains/${domain}/webhooks/${kind}`)
        if (refused(res)) throw new ProviderPermissionError('webhooks')
      }
    }
  },

  async deprovisionDomain(creds, domain, refs) {
    if (refs.routeId) await call(creds, creds.apiKey, 'DELETE', `/v3/routes/${refs.routeId}`)
    if (refs.created) await call(creds, creds.apiKey, 'DELETE', `/v3/domains/${domain}`)
  },

  providerSuppression: {
    mode: caps => caps.suppressionLists ? 'mirrored' : 'unmanaged',
    async release(creds, domain, address, list) {
      const path = list === 'bounce' ? 'bounces' : list === 'complaint' ? 'complaints' : 'unsubscribes'
      const res = await call(creds, creds.apiKey, 'DELETE', `/v3/${domain}/${path}/${encodeURIComponent(address)}`)
      if (!res.ok && res.status !== 404) throw fail(res, `${path} release`)
    }
  },

  async handleWebhook(creds, req) {
    const headers = lowerHeaders(req.headers)
    if (req.kind === 'events') {
      let body: Record<string, any>
      try {
        body = JSON.parse(req.rawBody.toString('utf8'))
      } catch {
        return { type: 'rejected', reason: 'Malformed payload' }
      }
      const sig = (body.signature && typeof body.signature === 'object') ? body.signature : body
      const error = verifySignature(creds.webhookSigningKey, sig)
      if (error) return { type: 'rejected', reason: error }
      const event = mapMailgunEvent((body['event-data'] ?? {}) as Record<string, any>)
      return { type: 'events', events: event ? [event] : [] }
    }

    const form = await parseForm(req.rawBody, headers['content-type'])
    const error = verifySignature(creds.webhookSigningKey, {
      timestamp: formString(form, 'timestamp'),
      token: formString(form, 'token'),
      signature: formString(form, 'signature')
    })
    if (error) return { type: 'rejected', reason: error }
    const mime = form.get('body-mime')
    const raw = typeof mime === 'string' ? Buffer.from(mime, 'utf8') : mime ? Buffer.from(await mime.arrayBuffer()) : null
    if (!raw) return { type: 'rejected', reason: 'The route must forward raw MIME (use the /inbound/mime URL)' }
    const recipients = formString(form, 'recipient').split(',').map(s => s.trim()).filter(Boolean)
    const mail = await parseInbound(raw, { to: recipients, from: formString(form, 'sender') || null })
    if (mail.headers.getAll('authentication-results').length === 0) {
      // Mailgun's own verdicts; the signing domain comes from the DKIM-Signature.
      const dkimPass = (mail.headers.get('x-mailgun-dkim-check-result') ?? '').toLowerCase() === 'pass'
      const signer = (mail.headers.get('dkim-signature') ?? '').match(/\bd=([a-z0-9.-]+)/i)?.[1]?.toLowerCase()
      mail.authentication = {
        dmarc: 'none',
        dkim: dkimPass && signer ? [{ domain: signer, result: 'pass' }] : [],
        spf: (mail.headers.get('x-mailgun-spf') ?? 'none').toLowerCase()
      }
    }
    const score = Number.parseFloat(mail.headers.get('x-mailgun-sscore') ?? '')
    mail.spamScore = Number.isNaN(score) ? null : score
    return { type: 'inbound', mail }
  }
}
