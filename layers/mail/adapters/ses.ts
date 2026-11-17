// Amazon SES over its HTTP APIs (no SDK), signed with SigV4 by hand. Sending
// uses SESv2 SendEmail with raw MIME and the domain's configuration set;
// events and inbound mail arrive as signed SNS notifications.
import { createHash, createHmac, createVerify } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import { parseInbound } from '../kernel/inbound-parse'
import { buildMime } from '../kernel/mime'
import {
  ProviderPermissionError, type Capabilities, type CheckResult, type Correlation, type Credentials, type DnsRecord,
  type MailEvent, type MailEventType, type MailProvider, type ManualStep, type ProviderSendResult, type WebhookResult
} from '../kernel/types'
import { request, type HttpResult } from './http'

// ---------- SigV4 ----------

export function awsEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request')
}

export interface SignV4Input {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string | Buffer
  service: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  date?: Date
}

// The headers to send (everything signed except Host, which fetch sets), with Authorization.
export function signV4(input: SignV4Input): Record<string, string> {
  const url = new URL(input.url)
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(input.body ?? '')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v
  headers.host = url.host
  headers['x-amz-date'] = amzDate
  if (input.service === 's3') headers['x-amz-content-sha256'] = payloadHash
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map(n => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const path = url.pathname || '/'
  // S3 signs the path as sent; every other service encodes each segment a second time.
  const canonicalUri = input.service === 's3' ? path : path.split('/').map(seg => awsEncode(seg)).join('/')
  const canonicalQuery = [...url.searchParams]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, dateStamp, input.region, input.service)).update(stringToSign).digest('hex')

  const { host: _host, ...out } = headers
  out.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return out
}

// ---------- AWS calls ----------

function sendRegion(creds: Credentials): string {
  return creds.region || 'us-east-1'
}

function receiveRegion(creds: Credentials): string {
  return creds.receiveRegion || sendRegion(creds)
}

function serviceUrl(creds: Credentials, host: 'email' | 'sns', region: string): string {
  return creds.endpoint ? creds.endpoint.replace(/\/$/, '') : `https://${host}.${region}.amazonaws.com`
}

async function aws(creds: Credentials, opts: { service: 'ses' | 'sns' | 's3', region: string, url: string, method: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }): Promise<HttpResult> {
  const headers = signV4({
    method: opts.method,
    url: opts.url,
    headers: opts.headers,
    body: opts.body,
    service: opts.service,
    region: opts.region,
    accessKeyId: creds.accessKeyId ?? '',
    secretAccessKey: creds.secretAccessKey ?? '',
    sessionToken: creds.sessionToken || undefined
  })
  return await request(opts.url, { method: opts.method, headers, body: opts.body, signal: opts.signal })
}

async function sesv2(creds: Credentials, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<HttpResult> {
  const region = sendRegion(creds)
  const json = body === undefined ? undefined : JSON.stringify(body)
  return await aws(creds, {
    service: 'ses',
    region,
    url: `${serviceUrl(creds, 'email', region)}${path}`,
    method,
    headers: json ? { 'content-type': 'application/json' } : {},
    body: json,
    signal
  })
}

// The Query APIs: classic SES (receipt rules) and SNS.
async function query(creds: Credentials, service: 'ses' | 'sns', region: string, params: Record<string, string>): Promise<HttpResult> {
  const body = new URLSearchParams({ ...params, Version: service === 'ses' ? '2010-12-01' : '2010-03-31' }).toString()
  return await aws(creds, {
    service,
    region,
    url: `${serviceUrl(creds, service === 'ses' ? 'email' : 'sns', region)}/`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body
  })
}

// fetch for binary bodies, with the same manually cleared timeout as request().
async function requestBytes(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number, ok: boolean, body: Buffer }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return { status: res.status, ok: res.ok, body: Buffer.from(await res.arrayBuffer()) }
  } finally {
    clearTimeout(timer)
  }
}

async function s3Get(creds: Credentials, bucket: string, key: string) {
  const region = receiveRegion(creds)
  const path = awsEncode(key, true)
  const url = creds.endpoint
    ? `${creds.endpoint.replace(/\/$/, '')}/${bucket}/${path}`
    : bucket.includes('.')
      ? `https://s3.${region}.amazonaws.com/${bucket}/${path}`
      : `https://${bucket}.s3.${region}.amazonaws.com/${path}`
  const headers = signV4({
    method: 'GET',
    url,
    service: 's3',
    region,
    accessKeyId: creds.accessKeyId ?? '',
    secretAccessKey: creds.secretAccessKey ?? '',
    sessionToken: creds.sessionToken || undefined
  })
  return await requestBytes(url, { method: 'GET', headers })
}

function denied(res: HttpResult): boolean {
  return res.status === 401 || res.status === 403
}

function keyInvalid(res: HttpResult): boolean {
  return denied(res) && /security token|signature we calculated|InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch|InvalidAccessKeyId|IncompleteSignature/i.test(res.text)
}

function alreadyExists(res: HttpResult): boolean {
  return res.status === 409 || /AlreadyExists/.test(res.text)
}

function fail(res: HttpResult, what: string): Error {
  return new Error(`Amazon SES ${what} responded ${res.status}: ${res.text.slice(0, 300)}`)
}

function xmlValue(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  if (!m) return null
  return m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

// ---------- Names, tags, records ----------

// One configuration set per domain, so `send` can name it from msg.domain alone.
export function configurationSetName(domain: string): string {
  const name = `nx-${domain.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return name.length <= 64 ? name : `${name.slice(0, 55)}-${sha256Hex(domain.toLowerCase()).slice(0, 8)}`
}

const TAG_SAFE = /^[A-Za-z0-9_-]{1,256}$/

// SES tag values take only letters, digits, `-` and `_`; anything else travels base64url under `<name>-b64`.
function tag(name: string, value: string): { Name: string, Value: string } | null {
  if (TAG_SAFE.test(value)) return { Name: name, Value: value }
  const encoded = Buffer.from(value, 'utf8').toString('base64url')
  return encoded.length <= 256 ? { Name: `${name}-b64`, Value: encoded } : null
}

export function sesTags(c: Correlation): { Name: string, Value: string }[] {
  const out: { Name: string, Value: string }[] = []
  for (const [name, value] of [['nx-stream', c.stream], ['nx-org', c.orgId], ['nx-ref', c.ref]] as const) {
    if (!value) continue
    const t = tag(name, value)
    if (t) out.push(t)
  }
  return out
}

function readTag(tags: Record<string, unknown> | undefined, name: string): string | null {
  const one = (v: unknown) => Array.isArray(v) ? (v[0] as string | undefined) : typeof v === 'string' ? v : undefined
  const encoded = one(tags?.[`${name}-b64`])
  if (encoded) return Buffer.from(encoded, 'base64url').toString('utf8')
  return one(tags?.[name]) || null
}

function addressOf(value: string): string {
  const m = value.match(/<([^>]+)>/)
  return (m ? m[1]! : value).trim().toLowerCase()
}

function domainOf(value: string): string | null {
  const a = addressOf(value)
  const at = a.lastIndexOf('@')
  return at === -1 ? null : a.slice(at + 1)
}

// SES's Message-ID host: email.amazonses.com in us-east-1, <region>.amazonses.com elsewhere.
// Not yet confirmed against a delivered message (plan Fact 8).
export function sesMessageId(id: string, region: string): string {
  return `<${id}@${region === 'us-east-1' ? 'email' : region}.amazonses.com>`
}

function recordStatus(status: unknown): DnsRecord['status'] {
  return status === 'SUCCESS' ? 'verified' : status === 'FAILED' ? 'failed' : 'pending'
}

function sendRecords(region: string, domain: string, identity: Record<string, any>): DnsRecord[] {
  const dkim = identity.DkimAttributes ?? {}
  const dkimStatus = recordStatus(dkim.Status)
  const records: DnsRecord[] = ((dkim.Tokens ?? []) as string[]).map(t => ({
    role: 'send', type: 'CNAME', name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`, status: dkimStatus, purpose: 'DKIM'
  }))
  const mailFrom = String(identity.MailFromAttributes?.MailFromDomain || `mail.${domain}`)
  const mfStatus = recordStatus(identity.MailFromAttributes?.MailFromDomainStatus)
  records.push(
    { role: 'send', type: 'MX', name: mailFrom, value: `feedback-smtp.${region}.amazonses.com`, priority: 10, status: mfStatus, purpose: 'MAIL FROM' },
    { role: 'send', type: 'TXT', name: mailFrom, value: 'v=spf1 include:amazonses.com ~all', status: mfStatus, purpose: 'SPF' }
  )
  return records
}

function receivingMx(region: string, domain: string, status: DnsRecord['status'] = 'pending'): DnsRecord {
  return { role: 'receive', type: 'MX', name: domain, value: `inbound-smtp.${region}.amazonaws.com`, priority: 10, status }
}

// SES event types for the kernel's event list. List drops arrive as bounces and complaints.
export function sesEventTypes(events: MailEventType[]): string[] {
  const types = new Set<string>()
  for (const e of events) {
    if (e === 'delivered') types.add('DELIVERY')
    if (e === 'bounced') types.add('BOUNCE')
    if (e === 'dropped') types.add('BOUNCE').add('COMPLAINT')
    if (e === 'deferred') types.add('BOUNCE').add('DELIVERY_DELAY')
    if (e === 'complained') types.add('COMPLAINT')
    if (e === 'rejected') types.add('REJECT')
    if (e === 'opened') types.add('OPEN')
    if (e === 'clicked') types.add('CLICK')
  }
  return [...types].sort()
}

// ---------- Event mapping ----------

export function mapSesEvent(event: Record<string, any>): MailEvent[] {
  const kind = String(event.eventType || event.notificationType || '')
  const mail = (event.mail ?? {}) as Record<string, any>
  const tags = mail.tags as Record<string, unknown> | undefined
  const base = {
    providerMessageId: mail.messageId ? String(mail.messageId) : null,
    stream: readTag(tags, 'nx-stream'),
    orgId: readTag(tags, 'nx-org'),
    ref: readTag(tags, 'nx-ref'),
    domain: mail.source ? domainOf(String(mail.source)) : null,
    permanent: false
  }
  const at = (ts: unknown) => new Date(String(ts || mail.timestamp || Date.now()))
  const destination = ((mail.destination ?? []) as unknown[]).map(d => addressOf(String(d)))
  const text = (v: unknown) => (v === undefined || v === null || v === '') ? null : String(v)

  switch (kind) {
    case 'Bounce': {
      const b = (event.bounce ?? {}) as Record<string, any>
      const type = String(b.bounceType || '')
      const sub = String(b.bounceSubType || '')
      return ((b.bouncedRecipients ?? []) as Record<string, unknown>[]).map((r): MailEvent => {
        const common = { ...base, recipient: addressOf(String(r.emailAddress || '')), occurredAt: at(b.timestamp), detail: text(r.diagnosticCode) ?? text(sub) }
        if (sub === 'OnAccountSuppressionList' || sub === 'Suppressed') return { ...common, type: 'dropped', list: 'bounce', permanent: true }
        if (type === 'Permanent') return { ...common, type: 'bounced', permanent: true }
        if (type === 'Transient') return { ...common, type: 'deferred' }
        return { ...common, type: 'bounced' }
      })
    }
    case 'Complaint': {
      const c = (event.complaint ?? {}) as Record<string, any>
      const listed = c.complaintSubType === 'OnAccountSuppressionList'
      return ((c.complainedRecipients ?? []) as Record<string, unknown>[]).map((r): MailEvent => {
        const common = { ...base, recipient: addressOf(String(r.emailAddress || '')), occurredAt: at(c.timestamp), detail: text(c.complaintFeedbackType) ?? text(c.complaintSubType) }
        return listed ? { ...common, type: 'dropped', list: 'complaint', permanent: true } : { ...common, type: 'complained' }
      })
    }
    case 'Delivery': {
      const d = (event.delivery ?? {}) as Record<string, any>
      return ((d.recipients ?? destination) as unknown[]).map((r): MailEvent => ({ ...base, type: 'delivered', recipient: addressOf(String(r)), occurredAt: at(d.timestamp), detail: text(d.smtpResponse) }))
    }
    case 'Reject': {
      const reason = text(event.reject?.reason)
      return destination.map((r): MailEvent => ({ ...base, type: 'rejected', permanent: true, recipient: r, occurredAt: at(null), detail: reason }))
    }
    case 'DeliveryDelay': {
      const d = (event.deliveryDelay ?? {}) as Record<string, any>
      return ((d.delayedRecipients ?? []) as Record<string, unknown>[]).map((r): MailEvent => ({
        ...base, type: 'deferred', recipient: addressOf(String(r.emailAddress || '')), occurredAt: at(d.timestamp), detail: text(r.diagnosticCode) ?? text(d.delayType)
      }))
    }
    case 'Open': return destination.map((r): MailEvent => ({ ...base, type: 'opened', recipient: r, occurredAt: at(event.open?.timestamp), detail: null }))
    case 'Click': return destination.map((r): MailEvent => ({ ...base, type: 'clicked', recipient: r, occurredAt: at(event.click?.timestamp), detail: text(event.click?.link) }))
    default: return []
  }
}

// ---------- SNS signatures ----------

type SnsMessage = Record<string, unknown>

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

export function isAwsSnsUrl(url: URL): boolean {
  return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && !url.port && !url.username && !url.password
}

let urlCheck: ((url: URL, purpose: 'cert' | 'subscribe') => boolean) | null = null

// Tests only: replaces the Amazon SNS host check. null restores it.
export function __setSnsUrlCheck(fn: ((url: URL, purpose: 'cert' | 'subscribe') => boolean) | null): void {
  urlCheck = fn
}

function trustedSnsUrl(raw: unknown, purpose: 'cert' | 'subscribe'): URL | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return (urlCheck ? urlCheck(url, purpose) : isAwsSnsUrl(url)) ? url : null
}

const certCache = new Map<string, string>()

async function signingCert(url: URL): Promise<string | null> {
  const cached = certCache.get(url.href)
  if (cached) return cached
  const res = await request(url.href, { timeoutMs: 10_000 })
  if (!res.ok || !res.text.includes('BEGIN CERTIFICATE')) return null
  if (certCache.size >= 50) certCache.delete(certCache.keys().next().value!)
  certCache.set(url.href, res.text)
  return res.text
}

export function snsStringToSign(m: SnsMessage): string | null {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  let out = ''
  for (const k of keys) {
    const v = m[k]
    if (typeof v !== 'string') {
      if (k === 'Subject' && (v === undefined || v === null)) continue
      return null
    }
    out += `${k}\n${v}\n`
  }
  return out
}

// Null when the message is signed by Amazon SNS, else the reason it isn't.
export async function verifySnsMessage(m: SnsMessage): Promise<string | null> {
  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(String(m.Type))) return 'Not an SNS message'
  const alg = m.SignatureVersion === '1' ? 'RSA-SHA1' : m.SignatureVersion === '2' ? 'RSA-SHA256' : null
  if (!alg) return 'Unsupported SNS signature version'
  const certUrl = trustedSnsUrl(m.SigningCertURL, 'cert')
  if (!certUrl) return 'The signing certificate isn\'t on an Amazon SNS host'
  if (typeof m.Signature !== 'string' || !m.Signature) return 'Missing signature'
  const text = snsStringToSign(m)
  if (!text) return 'Incomplete SNS message'
  const cert = await signingCert(certUrl)
  if (!cert) return 'Could not fetch the SNS signing certificate'
  let ok = false
  try {
    ok = createVerify(alg).update(text, 'utf8').verify(cert, m.Signature, 'base64')
  } catch {
    ok = false
  }
  return ok ? null : 'Invalid SNS signature'
}

async function inboundMail(creds: Credentials, n: Record<string, any>): Promise<WebhookResult> {
  const receipt = (n.receipt ?? {}) as Record<string, any>
  const action = (receipt.action ?? {}) as Record<string, any>
  const recipients = ((receipt.recipients ?? n.mail?.destination ?? []) as unknown[]).map(r => addressOf(String(r)))
  const from = n.mail?.source ? addressOf(String(n.mail.source)) : null
  let raw: Buffer | null = null
  if (action.type === 'S3') {
    const bucket = String(action.bucketName || '')
    const key = String(action.objectKey || '')
    if (!bucket || !key) return { type: 'rejected', reason: 'The notification names no S3 object' }
    if (creds.inboundBucket && bucket !== creds.inboundBucket) return { type: 'rejected', reason: 'The notification names a bucket this account doesn\'t receive into' }
    const res = await s3Get(creds, bucket, key)
    // Thrown so the request fails with a 5xx and SNS retries.
    if (!res.ok) throw new Error(`Amazon S3 responded ${res.status} for s3://${bucket}/${key}`)
    raw = res.body
  } else if (action.type === 'SNS' && typeof n.content === 'string') {
    raw = Buffer.from(n.content, action.encoding === 'BASE64' ? 'base64' : 'utf8')
  }
  if (!raw) return { type: 'rejected', reason: 'The receipt rule must store mail in S3 or include it in the SNS notification' }
  return { type: 'inbound', mail: await parseInbound(raw, { to: recipients, from }) }
}

// ---------- Provisioning helpers ----------

async function createTopic(creds: Credentials, region: string, name: string, capability: 'routes' | 'webhooks'): Promise<string> {
  const res = await query(creds, 'sns', region, { Action: 'CreateTopic', Name: name })
  if (denied(res)) throw new ProviderPermissionError(capability)
  const arn = res.ok ? xmlValue(res.text, 'TopicArn') : null
  if (!arn) throw fail(res, 'SNS topic create')
  return arn
}

async function subscribe(creds: Credentials, region: string, topicArn: string, endpoint: string, capability: 'routes' | 'webhooks'): Promise<void> {
  const res = await query(creds, 'sns', region, {
    Action: 'Subscribe',
    TopicArn: topicArn,
    Protocol: new URL(endpoint).protocol.replace(':', ''),
    Endpoint: endpoint,
    ReturnSubscriptionArn: 'true'
  })
  if (denied(res)) throw new ProviderPermissionError(capability)
  if (!res.ok) throw fail(res, 'SNS subscribe')
}

async function activeRuleSet(creds: Credentials, region: string): Promise<string> {
  const res = await query(creds, 'ses', region, { Action: 'DescribeActiveReceiptRuleSet' })
  if (denied(res)) throw new ProviderPermissionError('routes')
  if (!res.ok) throw fail(res, 'receipt rule set read')
  const active = xmlValue(res.text, 'Name')
  if (active) return active
  const name = 'nx-mail'
  const created = await query(creds, 'ses', region, { Action: 'CreateReceiptRuleSet', RuleSetName: name })
  if (denied(created)) throw new ProviderPermissionError('routes')
  if (!created.ok && !alreadyExists(created)) throw fail(created, 'receipt rule set create')
  const activated = await query(creds, 'ses', region, { Action: 'SetActiveReceiptRuleSet', RuleSetName: name })
  if (denied(activated)) throw new ProviderPermissionError('routes')
  if (!activated.ok) throw fail(activated, 'receipt rule set activate')
  return name
}

// ---------- Provider ----------

export const sesProvider: MailProvider = {
  id: 'ses',
  label: 'Amazon SES',
  credentialFields: [
    { key: 'accessKeyId', label: 'Access key ID', secret: false, env: 'MAIL_SES_ACCESS_KEY_ID' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true, env: 'MAIL_SES_SECRET_ACCESS_KEY' },
    { key: 'region', label: 'Sending region', secret: false, env: 'MAIL_SES_REGION', help: 'The AWS region you send from, e.g. eu-west-1' },
    { key: 'sessionToken', label: 'Session token', secret: true, optional: true, env: 'MAIL_SES_SESSION_TOKEN', help: 'Only for temporary credentials' },
    { key: 'receiveRegion', label: 'Receiving region', secret: false, optional: true, env: 'MAIL_SES_RECEIVE_REGION', help: 'Where SES receives mail, when it isn\'t the sending region (SES receives mail only in some regions)' },
    { key: 'inboundBucket', label: 'Inbound S3 bucket', secret: false, optional: true, env: 'MAIL_SES_INBOUND_BUCKET', help: 'Bucket in the receiving region that SES may write to. Stores mail up to 40 MB; without it, mail arrives inside the SNS notification, up to 150 KB.' },
    { key: 'endpoint', label: 'Endpoint override', secret: false, optional: true, help: 'Sends every AWS call to this base URL (local testing only)' }
  ],
  supports: { send: true, receive: true, events: true },
  webhookScope: 'domain',

  // GetAccount and GetEmailIdentity change nothing. Domain, route and webhook
  // writes have no harmless probe and stay untested. suppressionLists isn't
  // probed: the domain's configuration set turns SES's list off, so it only
  // matters (as false) when creating that set is refused.
  async verifyCredentials(creds, domain) {
    if (!creds.accessKeyId || !creds.secretAccessKey || !creds.region) {
      return { ok: false, error: 'Enter an access key ID, a secret access key and a region' }
    }
    const caps: Capabilities = {}
    const account = await sesv2(creds, 'GET', '/v2/email/account')
    if (keyInvalid(account)) return { ok: false, error: 'AWS rejected the access key' }
    let sendingEnabled: boolean | null = null
    if (account.ok) {
      const a = account.json() as { SendingEnabled?: boolean, EnforcementStatus?: string }
      sendingEnabled = a.SendingEnabled !== false && a.EnforcementStatus !== 'SHUTDOWN'
      if (!sendingEnabled) caps.send = false
    } else if (!denied(account)) {
      return { ok: false, error: `Amazon SES responded ${account.status}: ${account.text.slice(0, 200)}` }
    }
    if (domain) {
      const identity = await sesv2(creds, 'GET', `/v2/email/identities/${awsEncode(domain)}`)
      if (keyInvalid(identity)) return { ok: false, error: 'AWS rejected the access key' }
      if (identity.ok && sendingEnabled !== false) {
        const verified = (identity.json() as { VerifiedForSendingStatus?: boolean }).VerifiedForSendingStatus === true
        if (verified) caps.send = true
      }
    }
    return { ok: true, capabilities: caps }
  },

  manualSetup(domain, role, urls, { events }): ManualStep[] {
    const configSet = configurationSetName(domain)
    if (role === 'send') {
      const types = sesEventTypes(events)
      const steps: ManualStep[] = [
        { title: `In Amazon SES, create the domain identity ${domain}`, detail: 'Configuration → Identities → Create identity → Domain, in the region you send from. Use Easy DKIM and add the three CNAME records SES shows.' },
        { title: 'Set a custom MAIL FROM domain', detail: `On the identity, set the MAIL FROM domain to mail.${domain} and add the MX and TXT records SES shows.` },
        {
          title: `Create the configuration set ${configSet}`,
          detail: 'Configuration → Configuration sets → Create set, named exactly as below, in the same region. Under suppression list settings, override the account-level settings and leave both Bounce and Complaint unticked: the app keeps its own suppression list and names this set on every send.',
          values: [{ label: 'Configuration set', value: configSet }]
        }
      ]
      if (types.length) {
        steps.push({
          title: 'Send events to this app',
          detail: `Create an SNS topic in the same region with an HTTPS subscription to the URL below (the app confirms it). Then add an event destination to ${configSet} that publishes to the topic, with these event types: ${types.join(', ')}.`,
          values: [{ label: 'Events URL', value: urls.events }]
        })
      }
      steps.push({ title: 'Request production access', detail: 'New SES accounts are in the sandbox and can only send to verified identities. Account dashboard → Request production access.' })
      return steps
    }
    return [
      { title: 'Receive in a region where SES receives mail', detail: 'SES receives mail only in some regions, including us-east-1, us-west-2 and eu-west-1 (see "Email receiving endpoints" in the SES documentation). Set the account\'s receiving region to that region.' },
      { title: `Point the MX record of ${domain} at SES`, detail: 'One MX record, priority 10.', values: [{ label: 'MX', value: 'inbound-smtp.<receiving region>.amazonaws.com' }] },
      { title: 'Create an SNS topic for incoming mail', detail: 'In the receiving region, with an HTTPS subscription to the URL below (the app confirms it).', values: [{ label: 'Inbound URL', value: urls.inbound }] },
      {
        title: 'Add a receipt rule',
        detail: `Email receiving → the active rule set → Create rule for the recipient ${domain}. Add an S3 action that stores mail in the account's inbound bucket and notifies the topic above (mail up to 40 MB). Without a bucket, use an SNS action with Base64 encoding instead, which only carries mail up to 150 KB.`
      },
      { title: 'Sandbox note', detail: 'In the sandbox SES only sends to verified identities. The receiving probe still arrives, because the domain itself is verified, but replies to outside addresses fail until the account has production access.' }
    ]
  },

  async send(creds, msg): Promise<ProviderSendResult> {
    if (!creds.accessKeyId || !creds.secretAccessKey) return { status: 'failed', retryable: false, error: 'No AWS access key for this domain', keyRejected: true }
    const raw = await buildMime(msg)
    const body: Record<string, unknown> = {
      Destination: { ToAddresses: [msg.to] },
      Content: { Raw: { Data: raw.toString('base64') } },
      EmailTags: sesTags(msg.correlation),
      ConfigurationSetName: configurationSetName(msg.domain)
    }
    let res = await sesv2(creds, 'POST', '/v2/email/outbound-emails', body, msg.signal)
    // A missing set (manual setup that skipped it) shouldn't stop mail; SES's account-level list then applies.
    if ((res.status === 404 || res.status === 400) && /configuration set/i.test(res.text) && /exist|not found/i.test(res.text)) {
      const { ConfigurationSetName: _cs, ...rest } = body
      res = await sesv2(creds, 'POST', '/v2/email/outbound-emails', rest, msg.signal)
    }
    if (denied(res)) return { status: 'failed', retryable: false, error: `Amazon SES refused the key (${res.status})`, keyRejected: true }
    if (res.status === 429 || res.status >= 500 || /Throttl|rate exceeded/i.test(res.text)) return { status: 'failed', retryable: true, error: `Amazon SES responded ${res.status}` }
    if (!res.ok) return { status: 'failed', retryable: false, error: `Amazon SES responded ${res.status}: ${res.text.slice(0, 300)}` }
    const id = (res.json() as { MessageId?: string }).MessageId ?? null
    return { status: 'sent', providerMessageId: id, messageId: id ? sesMessageId(id, sendRegion(creds)) : null }
  },

  async provisionDomain(creds, domain, role, urls) {
    const configSet = configurationSetName(domain)
    if (role === 'send') {
      const region = sendRegion(creds)
      // A key that can't create the set leaves SES's own list in charge:
      // suppressionLists is reported false (mode `unmanaged`) and setup goes on.
      let cs = await sesv2(creds, 'POST', '/v2/email/configuration-sets', { ConfigurationSetName: configSet, SuppressionOptions: { SuppressedReasons: [] } })
      if (alreadyExists(cs)) cs = await sesv2(creds, 'PUT', `/v2/email/configuration-sets/${configSet}/suppression-options`, { SuppressedReasons: [] })
      if (!denied(cs) && !cs.ok) throw fail(cs, 'configuration set create')
      const haveSet = cs.ok

      let identity = await sesv2(creds, 'POST', '/v2/email/identities', { EmailIdentity: domain, ...(haveSet ? { ConfigurationSetName: configSet } : {}) })
      const created = identity.ok
      if (alreadyExists(identity)) identity = await sesv2(creds, 'GET', `/v2/email/identities/${awsEncode(domain)}`)
      if (denied(identity)) throw new ProviderPermissionError('domains')
      if (!identity.ok) throw fail(identity, 'identity create')

      const mailFrom = `mail.${domain}`
      const mf = await sesv2(creds, 'PUT', `/v2/email/identities/${awsEncode(domain)}/mail-from`, { MailFromDomain: mailFrom, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' })
      if (denied(mf)) throw new ProviderPermissionError('domains')
      if (!mf.ok) throw fail(mf, 'MAIL FROM setup')

      const body = identity.json() as Record<string, any>
      const records = sendRecords(region, domain, { ...body, MailFromAttributes: { MailFromDomain: mailFrom, ...(body.MailFromAttributes ?? {}) } })
      const tokens = (body.DkimAttributes?.Tokens ?? []) as string[]
      return { records, refs: { identityCreated: created, configurationSet: haveSet ? configSet : null, mailFrom }, dkimSelector: tokens[0], capabilities: { suppressionLists: haveSet } }
    }

    const region = receiveRegion(creds)
    const topicArn = await createTopic(creds, region, `${configSet}-inbound`, 'routes')
    await subscribe(creds, region, topicArn, urls.inbound, 'routes')
    const ruleSet = await activeRuleSet(creds, region)
    const action: Record<string, string> = creds.inboundBucket
      ? { 'Rule.Actions.member.1.S3Action.BucketName': creds.inboundBucket, 'Rule.Actions.member.1.S3Action.ObjectKeyPrefix': `nx-inbound/${domain}/`, 'Rule.Actions.member.1.S3Action.TopicArn': topicArn }
      : { 'Rule.Actions.member.1.SNSAction.TopicArn': topicArn, 'Rule.Actions.member.1.SNSAction.Encoding': 'Base64' }
    const params = {
      RuleSetName: ruleSet,
      'Rule.Name': configSet,
      'Rule.Enabled': 'true',
      'Rule.ScanEnabled': 'true',
      'Rule.TlsPolicy': 'Optional',
      'Rule.Recipients.member.1': domain,
      ...action
    }
    let res = await query(creds, 'ses', region, { Action: 'CreateReceiptRule', ...params })
    if (alreadyExists(res)) res = await query(creds, 'ses', region, { Action: 'UpdateReceiptRule', ...params })
    if (denied(res)) throw new ProviderPermissionError('routes')
    if (!res.ok) throw fail(res, 'receipt rule create')
    return { records: [receivingMx(region, domain)], refs: { ruleSet, rule: configSet, topicArn, bucket: creds.inboundBucket || null, region } }
  },

  async checkDomain(creds, domain, role, refs): Promise<CheckResult> {
    if (role === 'send') {
      const res = await sesv2(creds, 'GET', `/v2/email/identities/${awsEncode(domain)}`)
      if (denied(res)) throw new ProviderPermissionError('domains')
      if (res.status === 404) return { status: 'failed', records: [], error: 'The identity no longer exists in Amazon SES' }
      if (!res.ok) throw fail(res, 'identity check')
      const body = res.json() as Record<string, any>
      const records = sendRecords(sendRegion(creds), domain, body)
      const dkim = body.DkimAttributes?.Status
      const status = body.VerifiedForSendingStatus === true && dkim === 'SUCCESS' ? 'verified' : dkim === 'FAILED' ? 'failed' : 'pending'
      return { status, records, ...(status === 'failed' ? { error: 'SES could not find the DKIM records' } : {}) }
    }
    const region = typeof refs.region === 'string' ? refs.region : receiveRegion(creds)
    if (typeof refs.rule === 'string' && typeof refs.ruleSet === 'string') {
      const rule = await query(creds, 'ses', region, { Action: 'DescribeReceiptRule', RuleSetName: refs.ruleSet, RuleName: refs.rule })
      if (/RuleDoesNotExist|RuleSetDoesNotExist/.test(rule.text)) return { status: 'failed', records: [receivingMx(region, domain)], error: 'The receipt rule no longer exists in Amazon SES' }
    }
    const want = `inbound-smtp.${region}.amazonaws.com`
    const mx = await resolveMx(domain).catch(() => [])
    const pointed = mx.some(r => r.exchange.toLowerCase().replace(/\.$/, '') === want)
    return { status: pointed ? 'verified' : 'pending', records: [receivingMx(region, domain, pointed ? 'verified' : 'pending')] }
  },

  async configureWebhooks(creds, domain, urls, { events }) {
    const region = sendRegion(creds)
    const configSet = configurationSetName(domain)
    const destination = 'nx-events'
    const types = sesEventTypes(events)
    if (!types.length) {
      const res = await sesv2(creds, 'DELETE', `/v2/email/configuration-sets/${configSet}/event-destinations/${destination}`)
      if (denied(res)) throw new ProviderPermissionError('webhooks')
      return
    }
    const topicArn = await createTopic(creds, region, `${configSet}-events`, 'webhooks')
    await subscribe(creds, region, topicArn, urls.events, 'webhooks')
    const eventDestination = { Enabled: true, MatchingEventTypes: types, SnsDestination: { TopicArn: topicArn } }
    let res = await sesv2(creds, 'POST', `/v2/email/configuration-sets/${configSet}/event-destinations`, { EventDestinationName: destination, EventDestination: eventDestination })
    if (alreadyExists(res)) res = await sesv2(creds, 'PUT', `/v2/email/configuration-sets/${configSet}/event-destinations/${destination}`, { EventDestination: eventDestination })
    if (denied(res)) throw new ProviderPermissionError('webhooks')
    if (!res.ok) throw fail(res, 'event destination')
  },

  async deprovisionDomain(creds, domain, refs) {
    if (typeof refs.rule === 'string' && typeof refs.ruleSet === 'string') {
      await query(creds, 'ses', typeof refs.region === 'string' ? refs.region : receiveRegion(creds), { Action: 'DeleteReceiptRule', RuleSetName: refs.ruleSet, RuleName: refs.rule })
    }
    if (refs.identityCreated) await sesv2(creds, 'DELETE', `/v2/email/identities/${awsEncode(domain)}`)
    if (typeof refs.configurationSet === 'string') await sesv2(creds, 'DELETE', `/v2/email/configuration-sets/${refs.configurationSet}`)
  },

  providerSuppression: {
    // The configuration set overrides SES's account-level list to none.
    mode: caps => caps.suppressionLists === false ? 'unmanaged' : 'disabled'
  },

  async handleWebhook(creds, req) {
    let msg: SnsMessage
    try {
      msg = JSON.parse(req.rawBody.toString('utf8'))
    } catch {
      return { type: 'rejected', reason: 'Malformed payload' }
    }
    if (!msg || typeof msg !== 'object') return { type: 'rejected', reason: 'Malformed payload' }
    const error = await verifySnsMessage(msg)
    if (error) return { type: 'rejected', reason: error }

    if (msg.Type === 'SubscriptionConfirmation') {
      const url = trustedSnsUrl(msg.SubscribeURL, 'subscribe')
      if (!url) return { type: 'rejected', reason: 'The SubscribeURL isn\'t on an Amazon SNS host' }
      const res = await request(url.href, { timeoutMs: 10_000 })
      if (!res.ok) return { type: 'rejected', reason: `Confirming the SNS subscription failed (${res.status})` }
      return { type: 'handshake', response: { status: 'confirmed' } }
    }
    if (msg.Type === 'UnsubscribeConfirmation') return { type: 'handshake' }

    let body: Record<string, any>
    try {
      body = JSON.parse(String(msg.Message ?? ''))
    } catch {
      return { type: 'rejected', reason: 'Malformed notification' }
    }
    if (body.notificationType === 'Received') return await inboundMail(creds, body)
    return { type: 'events', events: mapSesEvent(body) }
  }
}
