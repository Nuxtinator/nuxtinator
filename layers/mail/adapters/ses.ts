// Amazon SES over its HTTP APIs (no SDK), signed with SigV4 by hand. Sending
// uses SESv2 SendEmail with raw MIME and the domain's configuration set;
// events and inbound mail arrive as signed SNS notifications.
import { createHash, createHmac, createVerify } from 'node:crypto'
import { resolveMx } from 'node:dns/promises'
import { parseInbound } from '../kernel/inbound-parse'
import { buildMime } from '../kernel/mime'
import {
  ProviderPermissionError, type Capabilities, type CheckResult, type Correlation, type Credentials, type DnsRecord,
  type DomainInspection, type MailEvent, type MailEventType, type MailProvider, type ManualStep, type ProviderSendResult, type WebhookResult
} from '../kernel/types'
import { EndpointError, providerEndpoint, request, type HttpResult } from './http'

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

// Regions go into hostnames, so anything but an AWS region name is refused.
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/

function awsRegion(value: string): string {
  if (!REGION.test(value)) throw new EndpointError(`"${value}" isn't an AWS region`)
  return value
}

function sendRegion(creds: Credentials): string {
  return awsRegion(creds.region || 'us-east-1')
}

function receiveRegion(creds: Credentials): string {
  return awsRegion(creds.receiveRegion || sendRegion(creds))
}

const SES_HOST = /^(email|email-fips)\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

// The endpoint override, when set and allowed. It applies to the SES email
// API only; SNS, STS and S3 keep their own hosts.
function endpointOverride(creds: Credentials): string | null {
  return providerEndpoint(creds.endpoint, SES_HOST, 'Amazon SES')
}

// Null when the regions and endpoint override are usable, else why not.
function configProblem(creds: Credentials): string | null {
  try {
    sendRegion(creds)
    receiveRegion(creds)
    endpointOverride(creds)
    return null
  } catch (err) {
    if (err instanceof EndpointError) return err.message
    throw err
  }
}

let serviceBase: ((service: 'sns' | 'sts' | 's3') => string) | null = null

// Tests only: sends SNS, STS and S3 calls to another base URL. null restores AWS's hosts.
export function __setAwsServiceBase(fn: ((service: 'sns' | 'sts' | 's3') => string) | null): void {
  serviceBase = fn
}

function serviceUrl(creds: Credentials, host: 'email' | 'sns' | 'sts', at: string): string {
  const fallback = `https://${host}.${awsRegion(at)}.amazonaws.com`
  return (host === 'email' ? endpointOverride(creds) : serviceBase?.(host)) ?? fallback
}

async function aws(creds: Credentials, opts: { service: 'ses' | 'sns' | 's3' | 'sts', region: string, url: string, method: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }): Promise<HttpResult> {
  awsRegion(opts.region)
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

const QUERY_VERSIONS = { ses: '2010-12-01', sns: '2010-03-31', sts: '2011-06-15' } as const

// The Query APIs: classic SES (receipt rules, identity notifications), SNS and STS.
async function query(creds: Credentials, service: 'ses' | 'sns' | 'sts', region: string, params: Record<string, string>): Promise<HttpResult> {
  const body = new URLSearchParams({ ...params, Version: QUERY_VERSIONS[service] }).toString()
  return await aws(creds, {
    service,
    region,
    url: `${serviceUrl(creds, service === 'ses' ? 'email' : service, region)}/`,
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
  const base = serviceBase?.('s3')
  const url = base
    ? `${base}/${bucket}/${path}`
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

function xmlDecode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}

function xmlValue(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m ? xmlDecode(m[1]!) : null
}

// Enough of an XML reader for the Query APIs' replies: elements, their children and text.
interface XmlNode { name: string, children: XmlNode[], text: string }
function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '', children: [], text: '' }
  const stack = [root]
  for (const m of text.matchAll(/<(\/?)([A-Za-z][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]!
    if (m[4] !== undefined) {
      top.text += xmlDecode(m[4])
    } else if (m[1]) {
      if (stack.length > 1) stack.pop()
    } else {
      const node: XmlNode = { name: m[2]!, children: [], text: '' }
      top.children.push(node)
      if (!m[3]) stack.push(node)
    }
  }
  return root
}
const xmlChild = (node: XmlNode | undefined, name: string) => node?.children.find(c => c.name === name)
const xmlChildren = (node: XmlNode | undefined, name: string) => node?.children.filter(c => c.name === name) ?? []
function xmlFind(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c
    const deeper = xmlFind(c, name)
    if (deeper) return deeper
  }
  return undefined
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

// The AWS account a key belongs to, cached per access key.
const accountIds = new Map<string, string>()
async function awsAccountId(creds: Credentials): Promise<string> {
  const cacheKey = `${creds.endpoint ?? ''}\n${creds.accessKeyId ?? ''}`
  const hit = accountIds.get(cacheKey)
  if (hit) return hit
  const res = await query(creds, 'sts', sendRegion(creds), { Action: 'GetCallerIdentity' })
  const id = res.ok ? xmlValue(res.text, 'Account') : null
  // Thrown so the request fails with a 5xx and SNS retries.
  if (!id) throw new Error(`AWS STS GetCallerIdentity responded ${res.status}`)
  if (accountIds.size >= 50) accountIds.delete(accountIds.keys().next().value!)
  accountIds.set(cacheKey, id)
  return id
}

// SNS topics this adapter subscribes: `nx-<domain>-events` and
// `nx-<domain>-inbound`, in the key's own AWS account.
export function snsTopicName(domain: string, kind: 'events' | 'inbound'): string {
  return `${configurationSetName(domain)}-${kind}`
}

const TOPIC_ARN = /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:(\d{12}):(nx-[a-z0-9-]+)$/

async function topicProblem(creds: Credentials, topicArn: unknown, kind: 'events' | 'inbound'): Promise<string | null> {
  const m = typeof topicArn === 'string' ? topicArn.match(TOPIC_ARN) : null
  if (!m || !m[2]!.endsWith(`-${kind}`)) return `The SNS topic isn't one this app subscribes to for ${kind}`
  if (m[1] !== await awsAccountId(creds)) return 'The SNS topic belongs to another AWS account'
  return null
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

// ---------- Reading what is set up ----------

// The event type names the SES console shows.
const EVENT_LABELS: Record<string, string> = {
  BOUNCE: 'Hard bounces',
  COMPLAINT: 'Complaints',
  DELIVERY: 'Deliveries',
  DELIVERY_DELAY: 'Delivery delays',
  REJECT: 'Rejects',
  OPEN: 'Opens',
  CLICK: 'Clicks'
}
const eventLabel = (type: string) => EVENT_LABELS[type] ?? type

// Addresses of this app's own webhooks.
const OWN_WEBHOOK = /\/api\/mail\/webhooks\//

const topicNameOf = (arn: unknown) => typeof arn === 'string' ? arn.split(':').pop() ?? '' : ''

// A topic's subscriptions (the first page), or null when the key can't list them.
async function subscriptions(creds: Credentials, region: string, topicArn: string): Promise<{ endpoint: string, confirmed: boolean }[] | null> {
  const res = await query(creds, 'sns', region, { Action: 'ListSubscriptionsByTopic', TopicArn: topicArn })
  if (!res.ok) return null
  return xmlChildren(xmlFind(parseXml(res.text), 'Subscriptions'), 'member').map(m => ({
    endpoint: xmlChild(m, 'Endpoint')?.text.trim() ?? '',
    confirmed: (xmlChild(m, 'SubscriptionArn')?.text.trim() ?? '').startsWith('arn:')
  }))
}

function subscriptionCheck(subs: { endpoint: string, confirmed: boolean }[], url: string, role: 'send' | 'receive', key: string, topic: string) {
  const sub = subs.find(s => s.endpoint === url)
  return {
    role, key, label: `SNS topic ${topic} sends to this app`, ok: !!sub?.confirmed,
    detail: !sub ? 'No subscription to the URL yet' : sub.confirmed ? undefined : 'The subscription waits for confirmation, which this app sends once SNS reaches the URL'
  }
}

interface ReceiptRule { name: string, enabled: boolean, recipients: string[], actions: { type: string, topicArn: string | null }[] }
function receiptRules(text: string): ReceiptRule[] {
  return xmlChildren(xmlFind(parseXml(text), 'Rules'), 'member').map(r => ({
    name: xmlChild(r, 'Name')?.text.trim() ?? '',
    enabled: xmlChild(r, 'Enabled')?.text.trim() === 'true',
    recipients: xmlChildren(xmlChild(r, 'Recipients'), 'member').map(m => m.text.trim().toLowerCase()),
    actions: xmlChildren(xmlChild(r, 'Actions'), 'member').flatMap(m => m.children.map(a => ({ type: a.name, topicArn: xmlChild(a, 'TopicArn')?.text.trim() ?? null })))
  }))
}

// Whether a rule's recipients take mail for the domain: none (all mail), the domain, one of its addresses, or a parent `.domain`.
function ruleMatches(rule: ReceiptRule, domain: string): boolean {
  return !rule.recipients.length || rule.recipients.some(r => r === domain || r.endsWith(`@${domain}`) || (r.startsWith('.') && domain.endsWith(r)))
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
    { key: 'inboundBucket', label: 'Inbound S3 bucket', secret: false, optional: true, env: 'MAIL_SES_INBOUND_BUCKET', help: 'Bucket in the receiving region that SES may write to, for mail up to 40 MB. Needed to set up receiving automatically; without it SES can only pass mail inside the SNS notification, and bounces anything over 150 KB.' },
    { key: 'endpoint', label: 'Endpoint override', secret: false, optional: true, help: 'Sends SES email API calls to this https base URL on amazonaws.com (e.g. a FIPS endpoint); SNS and STS keep their own hosts. Leave empty.' }
  ],
  supports: { send: true, receive: true, events: true },
  webhookScope: 'domain',
  // Each domain has its own configuration set.
  domainCapabilities: ['suppressionLists'],
  receivesAt: exchange => /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(exchange),
  notes: {
    send: 'New SES accounts start in the sandbox and send only to verified addresses until AWS grants production access.',
    receive: 'SES receives mail only in some regions, including us-east-1, us-west-2 and eu-west-1. In the sandbox, replies to outside addresses fail.'
  },

  // GetAccount, GetEmailIdentity and GetConfigurationSet change nothing.
  // Domain, route and webhook writes have no harmless probe and stay
  // untested. suppressionLists records whether the domain's configuration set
  // turns SES's own list off.
  async verifyCredentials(creds, domain) {
    if (!creds.accessKeyId || !creds.secretAccessKey || !creds.region) {
      return { ok: false, error: 'Enter an access key ID, a secret access key and a region' }
    }
    const badConfig = configProblem(creds)
    if (badConfig) return { ok: false, error: badConfig }
    const caps: Capabilities = {}
    const account = await sesv2(creds, 'GET', '/v2/email/account')
    if (keyInvalid(account)) return { ok: false, error: 'AWS rejected the access key' }
    let sendingEnabled: boolean | null = null
    if (account.ok) {
      const a = account.json() as { SendingEnabled?: boolean, EnforcementStatus?: string }
      sendingEnabled = a.SendingEnabled !== false && a.EnforcementStatus !== 'SHUTDOWN'
      if (!sendingEnabled) caps.send = false
    } else if (!denied(account)) {
      return { ok: false, error: `Amazon SES responded ${account.status}: ${account.text.slice(0, 200)}`, retryable: account.status === 429 || account.status >= 500 }
    }
    if (domain) {
      const identity = await sesv2(creds, 'GET', `/v2/email/identities/${awsEncode(domain)}`)
      if (keyInvalid(identity)) return { ok: false, error: 'AWS rejected the access key' }
      if (identity.ok && sendingEnabled !== false) {
        const verified = (identity.json() as { VerifiedForSendingStatus?: boolean }).VerifiedForSendingStatus === true
        if (verified) caps.send = true
      }
      // SES's own list is off only when the domain's configuration set exists and overrides it to none.
      const set = await sesv2(creds, 'GET', `/v2/email/configuration-sets/${configurationSetName(domain)}`)
      if (set.ok) {
        const reasons = (set.json() as { SuppressionOptions?: { SuppressedReasons?: string[] } }).SuppressionOptions?.SuppressedReasons
        caps.suppressionLists = Array.isArray(reasons) && reasons.length === 0
      } else if (set.status === 404) {
        caps.suppressionLists = false
      }
    }
    return { ok: true, capabilities: caps }
  },

  manualSetup(domain, role, urls, { events }): ManualStep[] {
    const configSet = configurationSetName(domain)
    if (role === 'send') {
      const types = sesEventTypes(events)
      const steps: ManualStep[] = [
        { title: `In Amazon SES, create the domain identity ${domain}`, detail: 'Configuration → Identities → Create identity → Domain, in the region you send from, with Easy DKIM. Skip this if it is already there.', check: 'provider-domain' },
        { title: 'Set a custom MAIL FROM domain', detail: `On the identity, set the MAIL FROM domain to mail.${domain}.` },
        { title: 'Add the DNS records SES shows', detail: 'At your DNS host: the three DKIM CNAME records and, for the MAIL FROM domain, an MX and a TXT record. SES checks them on its own; they are listed here once SES has the identity.', check: 'provider-dns' },
        {
          title: `Create the configuration set ${configSet}`,
          detail: 'Configuration → Configuration sets → Create set, named exactly as below, in the same region. Under suppression list settings, override the account-level settings and leave both Bounce and Complaint unticked: the app keeps its own suppression list and names this set on every send.',
          values: [{ label: 'Configuration set', value: configSet }],
          check: 'configuration-set'
        }
      ]
      if (types.length) {
        steps.push({
          title: 'Send events to this app',
          detail: `Create an SNS topic named ${snsTopicName(domain, 'events')} in the same region and AWS account, with an HTTPS subscription to the URL below (the app confirms it, and ignores topics with other names). Then add an event destination to ${configSet} that publishes to the topic, with these event types: ${types.map(eventLabel).join(', ')}.`,
          values: [{ label: 'SNS topic', value: snsTopicName(domain, 'events') }, { label: 'Events URL', value: urls.events }],
          check: 'webhooks'
        })
      }
      steps.push({ title: 'Request production access', detail: 'New SES accounts are in the sandbox and can only send to verified identities. Account dashboard → Request production access.', check: 'production-access' })
      return steps
    }
    return [
      { title: 'Receive in a region where SES receives mail', detail: 'SES receives mail only in some regions, including us-east-1, us-west-2 and eu-west-1 (see "Email receiving endpoints" in the SES documentation). Set the account\'s receiving region to that region.' },
      { title: `Point the MX record of ${domain} at SES`, detail: 'One MX record, priority 10.', values: [{ label: 'MX', value: 'inbound-smtp.<receiving region>.amazonaws.com' }], check: 'mx' },
      { title: 'Create an SNS topic for incoming mail', detail: 'Named as below, in the receiving region and the same AWS account, with an HTTPS subscription to the URL below (the app confirms it, and ignores topics with other names).', values: [{ label: 'SNS topic', value: snsTopicName(domain, 'inbound') }, { label: 'Inbound URL', value: urls.inbound }], check: 'inbound-topic' },
      {
        title: 'Add a receipt rule',
        detail: `Email receiving → the active rule set → Create rule for the recipient ${domain}. Add an S3 action that stores mail in the account's inbound bucket and notifies the topic above (mail up to 40 MB). Without a bucket, use an SNS action with Base64 encoding instead, which only carries mail up to 150 KB.`,
        check: 'route'
      },
      { title: 'Sandbox note', detail: 'In the sandbox SES only sends to verified identities. The receiving probe still arrives, because the domain itself is verified, but replies to outside addresses fail until the account has production access.' },
      { title: 'Verify receiving', detail: 'Press Verify receiving once the steps above are done: a probe message goes to the domain, and receiving is verified when it arrives here.', check: 'probe' }
    ]
  },

  // Reads only: the identity, the account, the configuration set and its
  // event destinations, the active receipt rule set and the topics' subscriptions.
  async inspectDomain(creds, domain, urls, { events, receive }): Promise<DomainInspection> {
    const seen: DomainInspection = { domain: null, webhooks: null, route: null, checks: [] }
    if (!creds.accessKeyId || !creds.secretAccessKey || !creds.region || configProblem(creds)) return seen
    const region = sendRegion(creds)

    const identity = await sesv2(creds, 'GET', `/v2/email/identities/${awsEncode(domain)}`)
    if (identity.status === 404) seen.domain = { exists: false, records: [] }
    else if (identity.ok) {
      const receiving = receive ? [receivingMx(receiveRegion(creds), domain)] : []
      seen.domain = { exists: true, records: [...sendRecords(region, domain, identity.json() as Record<string, any>), ...receiving] }
    }

    const account = await sesv2(creds, 'GET', '/v2/email/account')
    if (account.ok) {
      const production = (account.json() as { ProductionAccessEnabled?: boolean }).ProductionAccessEnabled === true
      seen.checks!.push({ role: 'send', key: 'production-access', label: 'The SES account has production access', ok: production, detail: production ? undefined : 'Still in the sandbox: mail only goes to verified addresses' })
    }

    const configSet = configurationSetName(domain)
    const types = sesEventTypes(events)
    const set = await sesv2(creds, 'GET', `/v2/email/configuration-sets/${configSet}`)
    if (set.status === 404) {
      seen.checks!.push({ role: 'send', key: 'configuration-set', label: `Configuration set ${configSet} exists`, ok: false, detail: 'Not created yet' })
      if (types.length) seen.webhooks = { missing: types.map(eventLabel), stale: [] }
    } else if (set.ok) {
      const reasons = (set.json() as { SuppressionOptions?: { SuppressedReasons?: string[] } }).SuppressionOptions?.SuppressedReasons
      const off = Array.isArray(reasons) && reasons.length === 0
      seen.checks!.push({ role: 'send', key: 'configuration-set', label: `Configuration set ${configSet} exists`, ok: off, detail: off ? undefined : 'It still suppresses bounces or complaints: override the account-level settings and untick both' })
      const dests = types.length ? await sesv2(creds, 'GET', `/v2/email/configuration-sets/${configSet}/event-destinations`) : null
      if (dests?.ok) {
        const topic = snsTopicName(domain, 'events')
        const list = (dests.json() as { EventDestinations?: { Enabled?: boolean, MatchingEventTypes?: string[], SnsDestination?: { TopicArn?: string } }[] }).EventDestinations ?? []
        const dest = list.find(d => d.Enabled !== false && topicNameOf(d.SnsDestination?.TopicArn) === topic)
        if (!dest) {
          seen.webhooks = { missing: types.map(eventLabel), stale: [] }
        } else {
          const subs = await subscriptions(creds, region, dest.SnsDestination!.TopicArn!)
          const covered = new Set(dest.MatchingEventTypes ?? [])
          const confirmed = !!subs?.some(s => s.endpoint === urls.events && s.confirmed)
          // Nothing arrives until the topic's subscription to the events URL is confirmed.
          const missing = subs && !confirmed ? types : types.filter(t => !covered.has(t))
          seen.webhooks = { missing: missing.map(eventLabel), stale: (subs ?? []).filter(s => s.endpoint !== urls.events && OWN_WEBHOOK.test(s.endpoint)).map(s => s.endpoint) }
          if (subs) seen.checks!.push(subscriptionCheck(subs, urls.events, 'send', 'events-topic', topic))
        }
      }
    }

    if (receive) {
      const rregion = receiveRegion(creds)
      const rules = await query(creds, 'ses', rregion, { Action: 'DescribeActiveReceiptRuleSet' })
      if (rules.ok) {
        const topic = snsTopicName(domain, 'inbound')
        const list = receiptRules(rules.text)
        const at = list.findIndex(r => r.enabled && ruleMatches(r, domain) && r.actions.some(a => (a.type === 'S3Action' || a.type === 'SNSAction') && topicNameOf(a.topicArn) === topic))
        // An earlier rule for the same mail that stops or bounces keeps it from reaching ours.
        const blocker = list.slice(0, at === -1 ? list.length : at).find(r => r.enabled && ruleMatches(r, domain) && r.actions.some(a => a.type === 'StopAction' || a.type === 'BounceAction'))
        seen.route = { ok: at !== -1 && !blocker, ...(blocker ? { conflict: blocker.name } : {}) }
        const arn = at === -1 ? null : list[at]!.actions.find(a => topicNameOf(a.topicArn) === topic)!.topicArn!
        const subs = arn ? await subscriptions(creds, rregion, arn) : null
        if (subs) seen.checks!.push(subscriptionCheck(subs, urls.inbound, 'receive', 'inbound-topic', topic))
      }
    }
    return seen
  },

  async send(creds, msg): Promise<ProviderSendResult> {
    if (!creds.accessKeyId || !creds.secretAccessKey) return { status: 'failed', retryable: false, error: 'No AWS access key for this domain', keyRejected: true }
    const badConfig = configProblem(creds)
    if (badConfig) return { status: 'failed', retryable: false, error: badConfig }
    const raw = await buildMime(msg)
    const body: Record<string, unknown> = {
      Destination: { ToAddresses: [msg.to] },
      Content: { Raw: { Data: raw.toString('base64') } },
      EmailTags: sesTags(msg.correlation),
      ConfigurationSetName: configurationSetName(msg.domain)
    }
    let res = await sesv2(creds, 'POST', '/v2/email/outbound-emails', body, msg.signal)
    // A missing set (refused or skipped at setup) shouldn't stop mail; SES's
    // account-level list then applies, and the domain's mode reports `unmanaged`.
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

    // Without a bucket SES could only pass mail inside the SNS notification,
    // and would bounce anything over 150 KB.
    if (!creds.inboundBucket) throw new Error('Set the account\'s inbound S3 bucket to receive automatically: without it SES bounces mail over 150 KB')
    const region = receiveRegion(creds)
    const topicArn = await createTopic(creds, region, snsTopicName(domain, 'inbound'), 'routes')
    await subscribe(creds, region, topicArn, urls.inbound, 'routes')
    const ruleSet = await activeRuleSet(creds, region)
    const action: Record<string, string> = { 'Rule.Actions.member.1.S3Action.BucketName': creds.inboundBucket, 'Rule.Actions.member.1.S3Action.ObjectKeyPrefix': `nx-inbound/${domain}/`, 'Rule.Actions.member.1.S3Action.TopicArn': topicArn }
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
    return { records: [receivingMx(region, domain)], refs: { ruleSet, rule: configSet, topicArn, bucket: creds.inboundBucket, region } }
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
    const region = typeof refs.region === 'string' ? awsRegion(refs.region) : receiveRegion(creds)
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
    const topicArn = await createTopic(creds, region, snsTopicName(domain, 'events'), 'webhooks')
    await subscribe(creds, region, topicArn, urls.events, 'webhooks')
    const eventDestination = { Enabled: true, MatchingEventTypes: types, SnsDestination: { TopicArn: topicArn } }
    let res = await sesv2(creds, 'POST', `/v2/email/configuration-sets/${configSet}/event-destinations`, { EventDestinationName: destination, EventDestination: eventDestination })
    if (alreadyExists(res)) res = await sesv2(creds, 'PUT', `/v2/email/configuration-sets/${configSet}/event-destinations/${destination}`, { EventDestination: eventDestination })
    if (denied(res)) throw new ProviderPermissionError('webhooks')
    if (res.status === 404) {
      // No configuration set (its creation was refused): the identity's own
      // notifications still report bounces and complaints, though without the
      // message tags, so they carry no stream, org or ref.
      for (const [type, on] of [['Bounce', true], ['Complaint', true], ['Delivery', events.includes('delivered')]] as const) {
        const set = await query(creds, 'ses', region, { Action: 'SetIdentityNotificationTopic', Identity: domain, NotificationType: type, ...(on ? { SnsTopic: topicArn } : {}) })
        if (denied(set)) throw new ProviderPermissionError('webhooks')
        if (!set.ok) throw fail(set, 'identity notification topic')
      }
      return
    }
    if (!res.ok) throw fail(res, 'event destination')
  },

  async deprovisionDomain(creds, domain, refs) {
    if (typeof refs.rule === 'string' && typeof refs.ruleSet === 'string') {
      await query(creds, 'ses', typeof refs.region === 'string' ? awsRegion(refs.region) : receiveRegion(creds), { Action: 'DeleteReceiptRule', RuleSetName: refs.ruleSet, RuleName: refs.rule })
    }
    if (refs.identityCreated) await sesv2(creds, 'DELETE', `/v2/email/identities/${awsEncode(domain)}`)
    if (typeof refs.configurationSet === 'string') await sesv2(creds, 'DELETE', `/v2/email/configuration-sets/${refs.configurationSet}`)
  },

  providerSuppression: {
    // `disabled` only once the domain's configuration set is known to override
    // SES's account-level list to none; until then SES's list may be in charge.
    mode: caps => caps.suppressionLists === true ? 'disabled' : 'unmanaged'
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
    const wrongTopic = await topicProblem(creds, msg.TopicArn, req.kind)
    if (wrongTopic) return { type: 'rejected', reason: wrongTopic }

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
