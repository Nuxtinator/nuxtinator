import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSign } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setAwsServiceBase, __setSnsUrlCheck, configurationSetName, isAwsSnsUrl, mapSesEvent, sesEventTypes, sesProvider, sesTags, signingKey,
  signV4, snsStringToSign
} from '../adapters/ses'
import { __setEndpointCheck } from '../adapters/http'
import { effectiveCapabilities } from '../kernel/context'
import { ProviderPermissionError, type MailAccountRow, type ProviderMessage, type WebhookRequest } from '../kernel/types'
import { db, harness, resetTables } from './helpers'

const CERT = readFileSync(resolve(__dirname, 'fixtures/sns-test-cert.pem'), 'utf8')
const KEY = readFileSync(resolve(__dirname, 'fixtures/sns-test-key.pem'), 'utf8')

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
  service: string | null
  action: string | null
  json: () => any
  // The request's SigV4 signature recomputes from what arrived
  signatureValid: boolean
}
type Reply = { status: number, json?: unknown, text?: string, contentType?: string }

const seen: Seen[] = []
let override: (req: Seen) => Reply | undefined = () => undefined
const objects = new Map<string, Buffer>()
let server: Server
let endpoint = ''

const ACCESS_KEY = 'AKIDTEST'
const SECRET_KEY = 'secret/test+key'
const REGION = 'eu-west-1'

const xml = (action: string, inner = '') => ({ status: 200, contentType: 'text/xml', text: `<${action}Response><${action}Result>${inner}</${action}Result></${action}Response>` })

function defaults(s: Seen): Reply {
  if (s.path === '/cert.pem') return { status: 200, text: CERT, contentType: 'text/plain' }
  if (s.path.startsWith('/confirm')) return { status: 200, text: '<ConfirmSubscriptionResponse/>', contentType: 'text/xml' }
  if (s.service === 's3') {
    const obj = objects.get(decodeURIComponent(s.path))
    return obj ? { status: 200, text: obj.toString('binary'), contentType: 'message/rfc822' } : { status: 404, text: 'NoSuchKey' }
  }
  if (s.action) {
    switch (s.action) {
      case 'CreateTopic': return xml('CreateTopic', `<TopicArn>arn:aws:sns:${REGION}:123456789012:${new URLSearchParams(s.body).get('Name')}</TopicArn>`)
      case 'Subscribe': return xml('Subscribe', '<SubscriptionArn>pending confirmation</SubscriptionArn>')
      case 'DescribeActiveReceiptRuleSet': return xml('DescribeActiveReceiptRuleSet')
      case 'GetCallerIdentity': return xml('GetCallerIdentity', '<Arn>arn:aws:iam::123456789012:user/test</Arn><UserId>AIDTEST</UserId><Account>123456789012</Account>')
      default: return xml(s.action)
    }
  }
  const identity = {
    IdentityType: 'DOMAIN',
    VerifiedForSendingStatus: true,
    DkimAttributes: { Status: 'SUCCESS', Tokens: ['tok1', 'tok2', 'tok3'] },
    MailFromAttributes: { MailFromDomain: 'mail.example.org', MailFromDomainStatus: 'SUCCESS' }
  }
  if (s.method === 'GET' && s.path === '/v2/email/account') return { status: 200, json: { SendingEnabled: true, ProductionAccessEnabled: true } }
  if (s.method === 'POST' && s.path === '/v2/email/identities') return { status: 200, json: { ...identity, VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: ['tok1', 'tok2', 'tok3'] }, MailFromAttributes: undefined } }
  if (s.method === 'GET' && s.path.startsWith('/v2/email/identities/')) return { status: 200, json: identity }
  if (s.method === 'POST' && s.path === '/v2/email/outbound-emails') return { status: 200, json: { MessageId: '0100018c-test-000000' } }
  if (s.method === 'GET' && s.path.startsWith('/v2/email/configuration-sets/')) return { status: 200, json: { ConfigurationSetName: s.path.split('/').pop(), SuppressionOptions: { SuppressedReasons: [] } } }
  return { status: 200, json: {} }
}

function verifyIncoming(req: IncomingMessage, body: string): { service: string | null, valid: boolean } {
  const auth = String(req.headers.authorization || '')
  const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/)
  if (!m) return { service: null, valid: false }
  const signed = m[5]!.split(';').filter(h => h !== 'host')
  const headers: Record<string, string> = {}
  for (const h of signed) headers[h] = String(req.headers[h] ?? '')
  const amz = headers['x-amz-date']!
  const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`)
  delete headers['x-amz-date']
  delete headers['x-amz-content-sha256']
  const again = signV4({ method: req.method ?? 'GET', url: `${endpoint}${req.url}`, headers, body, service: m[4]!, region: m[3]!, accessKeyId: m[1]!, secretAccessKey: SECRET_KEY, date })
  return { service: m[4]!, valid: again.authorization === auth && m[1] === ACCESS_KEY }
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const sig = verifyIncoming(req, body)
      const action = sig.service && sig.service !== 's3' && (req.url ?? '') === '/' ? new URLSearchParams(body).get('Action') : null
      const s: Seen = {
        method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, service: sig.service, action,
        json: () => JSON.parse(body), signatureValid: sig.valid
      }
      seen.push(s)
      const r = override(s) ?? defaults(s)
      res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/json' })
      if (r.text !== undefined) res.end(Buffer.from(r.text, r.contentType === 'message/rfc822' ? 'binary' : 'utf8'))
      else res.end(r.json === undefined ? '' : JSON.stringify(r.json))
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  __setEndpointCheck(url => url.hostname === '127.0.0.1')
  __setAwsServiceBase(() => endpoint)
})

afterAll(async () => {
  __setEndpointCheck(null)
  __setAwsServiceBase(null)
  await new Promise<void>(done => server.close(() => done()))
})

beforeEach(() => {
  seen.length = 0
  override = () => undefined
  objects.clear()
})

afterEach(() => {
  __setSnsUrlCheck(null)
})

const creds = (extra: Record<string, string> = {}) => ({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: REGION, endpoint, ...extra })
const account = {} as MailAccountRow
const urls = { events: 'https://app.example.org/api/mail/webhooks/a/t/events', inbound: 'https://app.example.org/api/mail/webhooks/a/t/inbound', inboundMime: 'https://app.example.org/api/mail/webhooks/a/t/inbound/mime' }

function message(extra: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    from: { name: 'App', address: 'noreply@example.org' },
    domain: 'example.org',
    to: 'person@example.com',
    replyTo: null,
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    messageId: '<abc@example.org>',
    headers: { 'Message-Id': '<abc@example.org>', 'In-Reply-To': '<prev@example.com>', 'References': '<prev@example.com>' },
    attachments: [],
    correlation: { stream: 'account', orgId: '6f1c2a54-9a5e-4c52-8d55-4e0a4b2f8b11', ref: 'ref_1' },
    bypassProviderSuppression: false,
    signal: new AbortController().signal,
    ...extra
  }
}

function snsMessage(fields: Record<string, string>, version: '1' | '2' = '2'): Record<string, string> {
  const m: Record<string, string> = {
    MessageId: 'b1f2c3d4-0000-4000-8000-000000000001',
    TopicArn: `arn:aws:sns:${REGION}:123456789012:nx-example-org-events`,
    Timestamp: '2026-11-17T10:00:00.000Z',
    SignatureVersion: version,
    SigningCertURL: `${endpoint}/cert.pem`,
    ...fields
  }
  m.Signature = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256').update(snsStringToSign(m)!).sign(KEY, 'base64')
  return m
}

function webhook(kind: 'events' | 'inbound', body: unknown): WebhookRequest {
  return { kind, headers: { 'content-type': 'text/plain; charset=UTF-8' }, rawBody: Buffer.from(JSON.stringify(body)), account }
}

const allowLocal = (purpose: 'cert' | 'subscribe' | 'both') => (u: URL, p: 'cert' | 'subscribe') =>
  (purpose === 'both' || purpose === p) ? u.hostname === '127.0.0.1' : isAwsSnsUrl(u)

describe('SigV4', () => {
  it('matches the get-vanilla test vector', () => {
    const headers = signV4({
      method: 'GET', url: 'https://example.amazonaws.com/', service: 'service', region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z')
    })
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  it('matches the IAM ListUsers example and its signing key', () => {
    expect(signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam').toString('hex'))
      .toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
    const headers = signV4({
      method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      service: 'iam', region: 'us-east-1',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z')
    })
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
  })

  it('matches the S3 GET Object example', () => {
    const headers = signV4({
      method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' },
      service: 's3', region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z')
    })
    expect(headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })
})

describe('send', () => {
  it('sends raw MIME with tags and the configuration set, and returns both ids', async () => {
    const res = await sesProvider.send(creds(), message())
    expect(res).toEqual({ status: 'sent', providerMessageId: '0100018c-test-000000', messageId: '<0100018c-test-000000@eu-west-1.amazonses.com>' })
    const call = seen.find(s => s.path === '/v2/email/outbound-emails')!
    expect(call.service).toBe('ses')
    expect(call.signatureValid).toBe(true)
    const body = call.json()
    expect(body.ConfigurationSetName).toBe('nx-example-org')
    expect(body.Destination).toEqual({ ToAddresses: ['person@example.com'] })
    expect(body.EmailTags).toEqual([
      { Name: 'nx-stream', Value: 'account' },
      { Name: 'nx-org', Value: '6f1c2a54-9a5e-4c52-8d55-4e0a4b2f8b11' },
      { Name: 'nx-ref', Value: 'ref_1' }
    ])
    const mime = Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8')
    expect(mime).toMatch(/^Subject: Hello$/m)
    expect(mime).toMatch(/^Message-ID: <abc@example\.org>$/im)
    expect(mime).toMatch(/^In-Reply-To: <prev@example\.com>$/m)
  })

  it('uses email.amazonses.com for us-east-1 message ids', async () => {
    const res = await sesProvider.send(creds({ region: 'us-east-1' }), message())
    expect(res).toMatchObject({ messageId: '<0100018c-test-000000@email.amazonses.com>' })
  })

  it('names the domain\'s configuration set on every send', async () => {
    await sesProvider.send(creds(), message())
    await sesProvider.send(creds(), message({ domain: 'news.example.org', correlation: { stream: 'newsletter', orgId: null, ref: null } }))
    const sends = seen.filter(s => s.path === '/v2/email/outbound-emails').map(s => s.json())
    expect(sends.map(b => b.ConfigurationSetName)).toEqual(['nx-example-org', 'nx-news-example-org'])
    expect(sends[1].EmailTags).toEqual([{ Name: 'nx-stream', Value: 'newsletter' }])
  })

  it('carries refs with other characters base64url-encoded', async () => {
    const ref = 'inbox:msg/42 é'
    const tags = sesTags({ stream: 'inbox', orgId: null, ref })
    expect(tags[1]).toEqual({ Name: 'nx-ref-b64', Value: Buffer.from(ref).toString('base64url') })
    const [event] = mapSesEvent({ eventType: 'Delivery', mail: { messageId: 'm', tags: { 'nx-stream': ['inbox'], 'nx-ref-b64': [tags[1]!.Value] } }, delivery: { recipients: ['a@b.c'] } })
    expect(event!.ref).toBe(ref)
  })

  it('maps failures: refused key, throttling, other client errors', async () => {
    override = s => s.path === '/v2/email/outbound-emails' ? { status: 403, json: { message: 'User is not authorized to perform ses:SendEmail' } } : undefined
    expect(await sesProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: false, keyRejected: true })
    override = s => s.path === '/v2/email/outbound-emails' ? { status: 429, json: { message: 'Maximum sending rate exceeded.' } } : undefined
    expect(await sesProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: true })
    override = s => s.path === '/v2/email/outbound-emails' ? { status: 503, json: {} } : undefined
    expect(await sesProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: true })
    override = s => s.path === '/v2/email/outbound-emails' ? { status: 400, json: { message: 'Email address is not verified.' } } : undefined
    const res = await sesProvider.send(creds(), message())
    expect(res).toMatchObject({ status: 'failed', retryable: false })
    expect(res).not.toHaveProperty('keyRejected')
  })

  it('still sends when the configuration set is missing', async () => {
    override = s => s.path === '/v2/email/outbound-emails' && s.json().ConfigurationSetName
      ? { status: 404, json: { message: 'Configuration set <nx-example-org> does not exist.' } }
      : undefined
    const res = await sesProvider.send(creds(), message())
    expect(res.status).toBe('sent')
    const sends = seen.filter(s => s.path === '/v2/email/outbound-emails').map(s => s.json())
    expect(sends).toHaveLength(2)
    expect(sends[1].ConfigurationSetName).toBeUndefined()
  })
})

describe('provisioning', () => {
  it('creates the configuration set with suppression none, then the identity and MAIL FROM', async () => {
    const res = await sesProvider.provisionDomain!(creds(), 'example.org', 'send', urls)
    const calls = seen.map(s => `${s.method} ${s.path}`)
    expect(calls).toEqual([
      'POST /v2/email/configuration-sets',
      'POST /v2/email/identities',
      'PUT /v2/email/identities/example.org/mail-from'
    ])
    expect(seen.every(s => s.signatureValid)).toBe(true)
    expect(seen[0]!.json()).toEqual({ ConfigurationSetName: 'nx-example-org', SuppressionOptions: { SuppressedReasons: [] } })
    expect(seen[1]!.json()).toEqual({ EmailIdentity: 'example.org', ConfigurationSetName: 'nx-example-org' })
    expect(seen[2]!.json()).toEqual({ MailFromDomain: 'mail.example.org', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' })
    expect(res.dkimSelector).toBe('tok1')
    expect(res.refs).toEqual({ identityCreated: true, configurationSet: 'nx-example-org', mailFrom: 'mail.example.org' })
    expect(res.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'CNAME', name: 'tok1._domainkey.example.org', value: 'tok1.dkim.amazonses.com', status: 'pending' }),
      expect.objectContaining({ type: 'MX', name: 'mail.example.org', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 }),
      expect.objectContaining({ type: 'TXT', name: 'mail.example.org', value: 'v=spf1 include:amazonses.com ~all' })
    ]))
    expect(res.records).toHaveLength(5)
  })

  it('resets suppression on an existing configuration set', async () => {
    override = s => s.method === 'POST' && s.path === '/v2/email/configuration-sets' ? { status: 409, json: { message: 'AlreadyExistsException' } } : undefined
    await sesProvider.provisionDomain!(creds(), 'example.org', 'send', urls)
    const put = seen.find(s => s.path === '/v2/email/configuration-sets/nx-example-org/suppression-options')!
    expect(put.method).toBe('PUT')
    expect(put.json()).toEqual({ SuppressedReasons: [] })
  })

  it('a refused configuration set leaves the mode unmanaged', async () => {
    override = s => s.path === '/v2/email/configuration-sets' ? { status: 403, json: { message: 'User is not authorized to perform ses:CreateConfigurationSet' } } : undefined
    const res = await sesProvider.provisionDomain!(creds(), 'example.org', 'send', urls)
    expect(res.capabilities).toEqual({ suppressionLists: false })
    expect(res.refs).toMatchObject({ configurationSet: null })
    expect(seen.find(s => s.method === 'POST' && s.path === '/v2/email/identities')!.json()).toEqual({ EmailIdentity: 'example.org' })
    expect(sesProvider.providerSuppression.mode({ suppressionLists: false })).toBe('unmanaged')
    expect(sesProvider.providerSuppression.mode({})).toBe('unmanaged')
    expect(sesProvider.providerSuppression.mode({ domains: true, send: true })).toBe('unmanaged')
    expect(sesProvider.providerSuppression.mode({ suppressionLists: true })).toBe('disabled')
  })

  it('a refused identity create is a domains refusal', async () => {
    override = s => s.method === 'POST' && s.path === '/v2/email/identities' ? { status: 403, json: { message: 'not authorized' } } : undefined
    const err = await sesProvider.provisionDomain!(creds(), 'example.org', 'send', urls).catch(e => e)
    expect(err).toBeInstanceOf(ProviderPermissionError)
    expect(err.capability).toBe('domains')
  })

  it('creates the receipt rule with an S3 action and returns the receiving MX', async () => {
    const res = await sesProvider.provisionDomain!(creds({ receiveRegion: 'us-west-2', inboundBucket: 'inbox-bucket' }), 'in.example.org', 'receive', urls)
    expect(seen.map(s => s.action)).toEqual(['CreateTopic', 'Subscribe', 'DescribeActiveReceiptRuleSet', 'CreateReceiptRuleSet', 'SetActiveReceiptRuleSet', 'CreateReceiptRule'])
    expect(seen.every(s => s.signatureValid)).toBe(true)
    expect(seen[0]!.service).toBe('sns')
    expect(seen[0]!.headers.authorization).toContain('/us-west-2/sns/aws4_request')
    expect(seen[2]!.service).toBe('ses')
    const sub = new URLSearchParams(seen[1]!.body)
    expect(sub.get('Endpoint')).toBe(urls.inbound)
    expect(sub.get('Protocol')).toBe('https')
    const rule = new URLSearchParams(seen[5]!.body)
    expect(rule.get('RuleSetName')).toBe('nx-mail')
    expect(rule.get('Rule.Recipients.member.1')).toBe('in.example.org')
    expect(rule.get('Rule.Actions.member.1.S3Action.BucketName')).toBe('inbox-bucket')
    expect(rule.get('Rule.Actions.member.1.S3Action.TopicArn')).toBe('arn:aws:sns:eu-west-1:123456789012:nx-in-example-org-inbound')
    expect(res.records).toEqual([{ role: 'receive', type: 'MX', name: 'in.example.org', value: 'inbound-smtp.us-west-2.amazonaws.com', priority: 10, status: 'pending' }])
    expect(res.refs).toMatchObject({ ruleSet: 'nx-mail', rule: 'nx-in-example-org', region: 'us-west-2' })
  })

  it('automatic receiving needs the inbound bucket, since SNS alone bounces mail over 150 KB', async () => {
    const err = await sesProvider.provisionDomain!(creds(), 'in.example.org', 'receive', urls).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ProviderPermissionError)
    expect(err.message).toMatch(/inbound S3 bucket.*150 KB/)
    expect(seen).toHaveLength(0)
  })

  it('a refused receipt rule is a routes refusal', async () => {
    override = s => s.action === 'CreateReceiptRule' ? { status: 403, contentType: 'text/xml', text: '<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>' } : undefined
    const err = await sesProvider.provisionDomain!(creds({ inboundBucket: 'inbox-bucket' }), 'in.example.org', 'receive', urls).catch(e => e)
    expect(err).toBeInstanceOf(ProviderPermissionError)
    expect(err.capability).toBe('routes')
  })

  it('checkDomain maps the DKIM status', async () => {
    expect((await sesProvider.checkDomain!(creds(), 'example.org', 'send', {})).status).toBe('verified')
    override = s => s.method === 'GET' ? { status: 200, json: { VerifiedForSendingStatus: false, DkimAttributes: { Status: 'FAILED', Tokens: ['t'] } } } : undefined
    expect((await sesProvider.checkDomain!(creds(), 'example.org', 'send', {})).status).toBe('failed')
    override = s => s.method === 'GET' ? { status: 200, json: { VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', Tokens: ['t'] } } } : undefined
    expect((await sesProvider.checkDomain!(creds(), 'example.org', 'send', {})).status).toBe('pending')
  })

  it('configureWebhooks subscribes the events URL and adds an SNS event destination', async () => {
    await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: true, events: ['delivered', 'bounced', 'dropped', 'complained'] })
    expect(seen.map(s => s.action ?? `${s.method} ${s.path}`)).toEqual(['CreateTopic', 'Subscribe', 'POST /v2/email/configuration-sets/nx-example-org/event-destinations'])
    expect(new URLSearchParams(seen[1]!.body).get('Endpoint')).toBe(urls.events)
    expect(seen[2]!.json()).toEqual({
      EventDestinationName: 'nx-events',
      EventDestination: { Enabled: true, MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY'], SnsDestination: { TopicArn: 'arn:aws:sns:eu-west-1:123456789012:nx-example-org-events' } }
    })

    seen.length = 0
    override = s => s.method === 'POST' && s.path.endsWith('/event-destinations') ? { status: 409, json: { message: 'AlreadyExistsException' } } : undefined
    await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: false, events: ['bounced'] })
    const put = seen.find(s => s.method === 'PUT')!
    expect(put.path).toBe('/v2/email/configuration-sets/nx-example-org/event-destinations/nx-events')
    expect(put.json().EventDestination.MatchingEventTypes).toEqual(['BOUNCE'])

    override = s => s.action === 'CreateTopic' ? { status: 403, contentType: 'text/xml', text: '<Error><Code>AuthorizationError</Code></Error>' } : undefined
    const err = await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: false, events: ['bounced'] }).catch(e => e)
    expect(err).toBeInstanceOf(ProviderPermissionError)
    expect(err.capability).toBe('webhooks')
  })

  it('without the configuration set, the event list goes to the identity\'s own notification topics', async () => {
    override = s => s.method === 'POST' && s.path.endsWith('/event-destinations') ? { status: 404, json: { message: 'Configuration set <nx-example-org> does not exist.' } } : undefined
    await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: false, events: ['bounced', 'complained'] })
    const set = seen.filter(s => s.action === 'SetIdentityNotificationTopic').map(s => Object.fromEntries(new URLSearchParams(s.body)))
    expect(set.map(p => [p.Identity, p.NotificationType, p.SnsTopic ?? null])).toEqual([
      ['example.org', 'Bounce', 'arn:aws:sns:eu-west-1:123456789012:nx-example-org-events'],
      ['example.org', 'Complaint', 'arn:aws:sns:eu-west-1:123456789012:nx-example-org-events'],
      ['example.org', 'Delivery', null]
    ])
    expect(seen.every(s => s.signatureValid)).toBe(true)

    override = s => s.method === 'POST' && s.path.endsWith('/event-destinations')
      ? { status: 404, json: { message: 'not found' } }
      : s.action === 'SetIdentityNotificationTopic' ? { status: 403, contentType: 'text/xml', text: '<Error><Code>AccessDenied</Code></Error>' } : undefined
    const err = await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: false, events: ['bounced'] }).catch(e => e)
    expect(err).toBeInstanceOf(ProviderPermissionError)
    expect(err.capability).toBe('webhooks')
  })

  it('verifyCredentials reports send for a verified identity and rejects a bad key', async () => {
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toEqual({ ok: true, capabilities: { send: true, suppressionLists: true } })
    expect(await sesProvider.verifyCredentials(creds())).toEqual({ ok: true, capabilities: {} })
    override = () => ({ status: 403, json: { message: 'The security token included in the request is invalid.' } })
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toMatchObject({ ok: false })
    expect(seen.every(s => s.method === 'GET')).toBe(true)
  })

  it('verifyCredentials reports SES\'s own list in charge when the configuration set is missing or keeps suppressing', async () => {
    override = s => s.path.startsWith('/v2/email/configuration-sets/') ? { status: 404, json: { message: 'not found' } } : undefined
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toEqual({ ok: true, capabilities: { send: true, suppressionLists: false } })
    override = s => s.path.startsWith('/v2/email/configuration-sets/') ? { status: 200, json: { SuppressionOptions: { SuppressedReasons: ['BOUNCE'] } } } : undefined
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toEqual({ ok: true, capabilities: { send: true, suppressionLists: false } })
    override = s => s.path.startsWith('/v2/email/configuration-sets/') ? { status: 403, json: { message: 'not authorized' } } : undefined
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toEqual({ ok: true, capabilities: { send: true } })
  })

  it('accepts only an https endpoint on an AWS host', async () => {
    __setEndpointCheck(null)
    try {
      for (const bad of ['http://169.254.169.254', 'https://evil.example.com', 'https://email.eu-west-1.amazonaws.com.evil.com', 'http://email.eu-west-1.amazonaws.com', 'https://email.eu-west-1.amazonaws.com:8443']) {
        expect(await sesProvider.verifyCredentials(creds({ endpoint: bad }), 'example.org')).toMatchObject({ ok: false, error: expect.stringContaining('https URL') })
        expect(await sesProvider.send(creds({ endpoint: bad }), message())).toMatchObject({ status: 'failed', retryable: false })
      }
      expect(seen).toHaveLength(0)
    } finally {
      __setEndpointCheck(url => url.hostname === '127.0.0.1')
    }
  })

  it('refuses any region that isn\'t an AWS region name, before any request', async () => {
    for (const bad of ['evil.example/x', 'us-east-1.evil.example', 'US-EAST-1', 'eu-west-1/']) {
      expect(await sesProvider.verifyCredentials(creds({ region: bad }), 'example.org')).toMatchObject({ ok: false, error: expect.stringContaining('AWS region') })
      expect(await sesProvider.verifyCredentials(creds({ receiveRegion: bad }), 'example.org')).toMatchObject({ ok: false, error: expect.stringContaining('AWS region') })
      expect(await sesProvider.send(creds({ region: bad }), message())).toMatchObject({ status: 'failed', retryable: false })
      await expect(sesProvider.provisionDomain!(creds({ region: bad }), 'example.org', 'send', urls)).rejects.toThrow('AWS region')
      await expect(sesProvider.provisionDomain!(creds({ receiveRegion: bad, inboundBucket: 'b' }), 'example.org', 'receive', urls)).rejects.toThrow('AWS region')
      await expect(sesProvider.checkDomain!(creds(), 'example.org', 'receive', { region: bad, rule: 'r', ruleSet: 's' })).rejects.toThrow('AWS region')
      await expect(sesProvider.configureWebhooks!(creds({ region: bad }), 'example.org', urls, { delivered: false, events: ['bounced'] })).rejects.toThrow('AWS region')
      await expect(sesProvider.deprovisionDomain!(creds(), 'example.org', { region: bad, rule: 'r', ruleSet: 's' })).rejects.toThrow('AWS region')
    }
    expect(seen).toHaveLength(0)
  })

  it('a 5xx from SES while verifying is marked retryable', async () => {
    override = s => s.path === '/v2/email/account' ? { status: 503, json: { message: 'unavailable' } } : undefined
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toMatchObject({ ok: false, retryable: true })
    override = s => s.path === '/v2/email/account' ? { status: 400, json: { message: 'bad' } } : undefined
    expect(await sesProvider.verifyCredentials(creds(), 'example.org')).toMatchObject({ ok: false, retryable: false })
  })

  it('the endpoint override moves only the SES email API; SNS and STS keep their own hosts', async () => {
    __setAwsServiceBase(null)
    const hosts: string[] = []
    const real = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.host === new URL(endpoint).host) return await real(input, init)
      hosts.push(url.host)
      const action = new URLSearchParams(String(init?.body ?? '')).get('Action')
      const body = action === 'CreateTopic'
        ? `<CreateTopicResponse><CreateTopicResult><TopicArn>arn:aws:sns:${REGION}:123456789012:nx-example-org-events</TopicArn></CreateTopicResult></CreateTopicResponse>`
        : `<${action}Response/>`
      return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } })
    })
    try {
      await sesProvider.configureWebhooks!(creds(), 'example.org', urls, { delivered: false, events: ['bounced'] })
    } finally {
      spy.mockRestore()
      __setAwsServiceBase(() => endpoint)
    }
    expect(hosts).toEqual([`sns.${REGION}.amazonaws.com`, `sns.${REGION}.amazonaws.com`])
    expect(seen.map(s => s.path)).toEqual(['/v2/email/configuration-sets/nx-example-org/event-destinations'])
  })

  it('manual steps name the configuration set and the SES event types', () => {
    const send = sesProvider.manualSetup('example.org', 'send', urls, { events: ['delivered', 'bounced', 'deferred'] })
    const text = JSON.stringify(send)
    expect(text).toContain('nx-example-org')
    expect(text).toContain('BOUNCE, DELIVERY, DELIVERY_DELAY')
    expect(text).toContain(urls.events)
    const receive = JSON.stringify(sesProvider.manualSetup('example.org', 'receive', urls, { events: [] }))
    expect(receive).toContain('us-east-1, us-west-2 and eu-west-1')
    expect(receive).toContain('sandbox')
    expect(receive).toContain(urls.inbound)
  })

  it('names configuration sets within SES\'s limit', () => {
    expect(configurationSetName('Mail.Example.org')).toBe('nx-mail-example-org')
    const long = configurationSetName(`${'a'.repeat(70)}.example.org`)
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('kernel: refused configuration set', () => {
  beforeEach(resetTables)

  it('keeps automatic setup with the mode unmanaged', async () => {
    override = s => s.path === '/v2/email/configuration-sets' ? { status: 403, json: { message: 'not authorized' } } : undefined
    const { mail } = harness({ providers: [sesProvider], env: {} })
    const { account: acct } = await mail.admin.createAccount({ orgId: null }, { provider: 'ses', credentials: creds() })
    const { setup } = await mail.admin.addDomain({ orgId: null }, { domain: 'example.org', sendAccountId: acct.id }, 'https://app.example.org')
    expect(setup?.roles).toEqual([{ role: 'send', mode: 'auto' }])
    const row = await db().selectFrom('mail_domains').selectAll().where('domain', '=', 'example.org').executeTakeFirstOrThrow()
    const account = await db().selectFrom('mail_accounts').selectAll().where('id', '=', acct.id).executeTakeFirstOrThrow()
    expect(row.capabilities).toMatchObject({ suppressionLists: false })
    expect(sesProvider.providerSuppression.mode(effectiveCapabilities(account, row))).toBe('unmanaged')
  })

  it('keeps each domain\'s configuration-set result on the domain, so two domains on one account don\'t share a mode', async () => {
    override = (s) => {
      if (s.method === 'POST' && s.path === '/v2/email/configuration-sets' && s.json().ConfigurationSetName === 'nx-a-example-org') return { status: 403, json: { message: 'not authorized' } }
      if (s.method === 'GET' && s.path === '/v2/email/configuration-sets/nx-a-example-org') return { status: 404, json: { message: 'not found' } }
      return undefined
    }
    const { mail } = harness({ providers: [sesProvider], env: {} })
    const { account: acct } = await mail.admin.createAccount({ orgId: null }, { provider: 'ses', credentials: creds() })
    await mail.admin.addDomain({ orgId: null }, { domain: 'a.example.org', sendAccountId: acct.id }, 'https://app.example.org')
    await mail.admin.addDomain({ orgId: null }, { domain: 'b.example.org', sendAccountId: acct.id }, 'https://app.example.org')
    const account = await db().selectFrom('mail_accounts').selectAll().where('id', '=', acct.id).executeTakeFirstOrThrow()
    expect(account.capabilities).not.toHaveProperty('suppressionLists')
    const mode = async (name: string) => {
      const row = await db().selectFrom('mail_domains').selectAll().where('domain', '=', name).executeTakeFirstOrThrow()
      return sesProvider.providerSuppression.mode(effectiveCapabilities(account, row))
    }
    expect(await mode('a.example.org')).toBe('unmanaged')
    expect(await mode('b.example.org')).toBe('disabled')

    // Re-verifying the account probes one domain; the other keeps its own result.
    await mail.admin.verifyAccount({ orgId: null }, acct.id)
    expect(await mode('a.example.org')).toBe('unmanaged')
    expect(await mode('b.example.org')).toBe('disabled')
  })

  it('still learns of bounces: the check routes them through the identity\'s notification topics', async () => {
    override = s => s.path === '/v2/email/configuration-sets'
      ? { status: 403, json: { message: 'not authorized' } }
      : s.method === 'POST' && s.path.endsWith('/event-destinations') ? { status: 404, json: { message: 'Configuration set <nx-example-org> does not exist.' } } : undefined
    const { mail } = harness({ providers: [sesProvider], env: {} })
    const { account: acct } = await mail.admin.createAccount({ orgId: null }, { provider: 'ses', credentials: creds() })
    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'example.org', sendAccountId: acct.id }, 'https://app.example.org')
    seen.length = 0
    const check = await mail.admin.checkDomain({ orgId: null }, domain.id, 'https://app.example.org')
    expect(check.webhooks).toEqual({ ok: true })
    expect(seen.filter(s => s.action === 'SetIdentityNotificationTopic').map(s => new URLSearchParams(s.body).get('NotificationType'))).toEqual(['Bounce', 'Complaint', 'Delivery'])
    const row = await db().selectFrom('mail_domains').select('webhook_events').where('id', '=', domain.id).executeTakeFirstOrThrow()
    expect(row.webhook_events).toContain('bounced')
  })
})

describe('kernel: a send and its events', () => {
  beforeEach(resetTables)

  it('returns both ids, threads a reply on the Message-ID, and an event reaches the handler with the send\'s ref', async () => {
    const events: { type: string, ref: string | null, stream: string | null }[] = []
    const { mail } = harness({
      providers: [sesProvider],
      env: {},
      eventHandlers: [{ id: 'h', handle: async e => void events.push({ type: e.type, ref: e.ref, stream: e.stream }) }]
    })
    const { account: acct } = await mail.admin.createAccount({ orgId: null }, { provider: 'ses', credentials: creds() })
    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'example.org', sendAccountId: acct.id }, 'https://app.example.org')
    await mail.admin.checkDomain({ orgId: null }, domain.id, 'https://app.example.org')
    await mail.admin.setStreamRoute({ orgId: null }, 'system', domain.id, 'https://app.example.org')

    seen.length = 0
    const first = await mail.send({ stream: 'system', to: 'person@example.com', subject: 'Hi', html: '<p>Hi</p>', ref: 'msg_42' })
    expect(first).toMatchObject({ status: 'sent', providerMessageId: '0100018c-test-000000', messageId: '<0100018c-test-000000@eu-west-1.amazonses.com>' })
    const sent = seen.find(s => s.path === '/v2/email/outbound-emails')!.json()
    expect(sent.ConfigurationSetName).toBe('nx-example-org')

    seen.length = 0
    const reply = await mail.send({ stream: 'system', to: 'person@example.com', subject: 'Re: Hi', html: '<p>Again</p>', inReplyTo: (first as { messageId: string }).messageId, references: (first as { messageId: string }).messageId })
    expect(reply.status).toBe('sent')
    const mime = Buffer.from(seen.find(s => s.path === '/v2/email/outbound-emails')!.json().Content.Raw.Data, 'base64').toString('utf8')
    expect(mime).toMatch(/^In-Reply-To: <0100018c-test-000000@eu-west-1\.amazonses\.com>$/m)

    __setSnsUrlCheck(allowLocal('cert'))
    const tags = Object.fromEntries((sent.EmailTags as { Name: string, Value: string }[]).map(t => [t.Name, [t.Value]]))
    const delivery = JSON.stringify({
      eventType: 'Delivery',
      mail: { messageId: '0100018c-test-000000', source: 'noreply@example.org', destination: ['person@example.com'], tags },
      delivery: { timestamp: new Date().toISOString(), recipients: ['person@example.com'] }
    })
    const body = Buffer.from(JSON.stringify(snsMessage({ Type: 'Notification', Message: delivery })))
    const res = await mail.handleWebhook({ accountId: acct.id, token: mail.webhookToken(acct), kind: 'events', headers: { 'content-type': 'text/plain' }, rawBody: body })
    expect(res.status).toBe(200)
    expect(events).toEqual([{ type: 'delivered', ref: 'msg_42', stream: 'system' }])
  })
})

describe('event mapping', () => {
  const mail = {
    messageId: '0100018c-test-000000',
    source: '"App" <noreply@example.org>',
    timestamp: '2026-11-17T10:00:00.000Z',
    destination: ['a@example.com', 'b@example.com'],
    tags: { 'nx-stream': ['account'], 'nx-org': ['org-1'], 'nx-ref': ['ref_1'], 'ses:configuration-set': ['nx-example-org'] }
  }

  it('maps a permanent bounce, one event per recipient, with correlation from the tags', () => {
    const events = mapSesEvent({
      eventType: 'Bounce', mail,
      bounce: { bounceType: 'Permanent', bounceSubType: 'General', timestamp: '2026-11-17T10:01:00.000Z', bouncedRecipients: [{ emailAddress: 'a@example.com', diagnosticCode: 'smtp; 550 no such user' }, { emailAddress: 'B@example.com' }] }
    })
    expect(events).toEqual([
      { type: 'bounced', permanent: true, recipient: 'a@example.com', providerMessageId: '0100018c-test-000000', occurredAt: new Date('2026-11-17T10:01:00.000Z'), detail: 'smtp; 550 no such user', stream: 'account', orgId: 'org-1', ref: 'ref_1', domain: 'example.org' },
      expect.objectContaining({ type: 'bounced', recipient: 'b@example.com', detail: 'General' })
    ])
  })

  it('maps transient bounces to deferred and list bounces to dropped', () => {
    const transient = mapSesEvent({ eventType: 'Bounce', mail, bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', bouncedRecipients: [{ emailAddress: 'a@example.com' }] } })
    expect(transient[0]).toMatchObject({ type: 'deferred', permanent: false })
    for (const sub of ['OnAccountSuppressionList', 'Suppressed']) {
      const [e] = mapSesEvent({ notificationType: 'Bounce', mail, bounce: { bounceType: 'Permanent', bounceSubType: sub, bouncedRecipients: [{ emailAddress: 'a@example.com' }] } })
      expect(e).toMatchObject({ type: 'dropped', list: 'bounce', permanent: true, ref: 'ref_1' })
    }
    const undetermined = mapSesEvent({ eventType: 'Bounce', mail, bounce: { bounceType: 'Undetermined', bouncedRecipients: [{ emailAddress: 'a@example.com' }] } })
    expect(undetermined[0]).toMatchObject({ type: 'bounced', permanent: false })
  })

  it('maps complaints, list complaints, deliveries, rejects and delays', () => {
    expect(mapSesEvent({ eventType: 'Complaint', mail, complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'a@example.com' }] } })[0])
      .toMatchObject({ type: 'complained', detail: 'abuse' })
    expect(mapSesEvent({ eventType: 'Complaint', mail, complaint: { complaintSubType: 'OnAccountSuppressionList', complainedRecipients: [{ emailAddress: 'a@example.com' }] } })[0])
      .toMatchObject({ type: 'dropped', list: 'complaint', permanent: true })
    const delivered = mapSesEvent({ eventType: 'Delivery', mail, delivery: { timestamp: '2026-11-17T10:02:00.000Z', recipients: ['a@example.com', 'b@example.com'], smtpResponse: '250 ok' } })
    expect(delivered.map(e => [e.type, e.recipient, e.ref])).toEqual([['delivered', 'a@example.com', 'ref_1'], ['delivered', 'b@example.com', 'ref_1']])
    const rejected = mapSesEvent({ eventType: 'Reject', mail, reject: { reason: 'Bad content' } })
    expect(rejected).toHaveLength(2)
    expect(rejected[0]).toMatchObject({ type: 'rejected', permanent: true, detail: 'Bad content' })
    expect(mapSesEvent({ eventType: 'DeliveryDelay', mail, deliveryDelay: { delayType: 'MailboxFull', delayedRecipients: [{ emailAddress: 'a@example.com' }] } })[0])
      .toMatchObject({ type: 'deferred', detail: 'MailboxFull' })
    expect(mapSesEvent({ eventType: 'Send', mail })).toEqual([])
  })

  it('subscribes to the SES event types the kernel needs', () => {
    expect(sesEventTypes(['dropped'])).toEqual(['BOUNCE', 'COMPLAINT'])
    expect(sesEventTypes(['deferred', 'rejected', 'opened', 'clicked'])).toEqual(['BOUNCE', 'CLICK', 'DELIVERY_DELAY', 'OPEN', 'REJECT'])
  })
})

describe('SNS webhooks', () => {
  const bounce = JSON.stringify({
    eventType: 'Bounce',
    mail: { messageId: 'm-1', source: 'noreply@example.org', destination: ['a@example.com'], tags: { 'nx-stream': ['account'], 'nx-ref': ['r-9'] } },
    bounce: { bounceType: 'Permanent', bounceSubType: 'OnAccountSuppressionList', bouncedRecipients: [{ emailAddress: 'a@example.com' }] }
  })

  it('accepts a signed notification (versions 1 and 2) and maps its events', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    for (const version of ['1', '2'] as const) {
      const res = await sesProvider.handleWebhook(creds(), webhook('events', snsMessage({ Type: 'Notification', Message: bounce }, version)))
      expect(res).toEqual({ type: 'events', events: [expect.objectContaining({ type: 'dropped', list: 'bounce', recipient: 'a@example.com', stream: 'account', ref: 'r-9', providerMessageId: 'm-1' })] })
    }
  })

  it('rejects a topic this app doesn\'t subscribe, or one in another AWS account', async () => {
    __setSnsUrlCheck(allowLocal('both'))
    const cases: [string, 'events' | 'inbound'][] = [
      [`arn:aws:sns:${REGION}:999999999999:nx-example-org-events`, 'events'],
      [`arn:aws:sns:${REGION}:123456789012:someone-elses-topic`, 'events'],
      [`arn:aws:sns:${REGION}:123456789012:nx-example-org-inbound`, 'events'],
      [`arn:aws:sns:${REGION}:123456789012:nx-example-org-events`, 'inbound']
    ]
    for (const [arn, kind] of cases) {
      const res = await sesProvider.handleWebhook(creds(), webhook(kind, snsMessage({ Type: 'Notification', Message: bounce, TopicArn: arn })))
      expect(res).toMatchObject({ type: 'rejected', reason: expect.stringMatching(/SNS topic/) })
    }
    const confirm = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'confirm', Token: 'tok', SubscribeURL: `${endpoint}/confirm?Token=tok`, TopicArn: `arn:aws:sns:${REGION}:999999999999:nx-example-org-events` })
    expect(await sesProvider.handleWebhook(creds(), webhook('events', confirm))).toMatchObject({ type: 'rejected' })
    expect(seen.some(s => s.path.startsWith('/confirm'))).toBe(false)
  })

  it('rejects a bad signature', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    const msg = snsMessage({ Type: 'Notification', Message: bounce })
    msg.Message = msg.Message!.replace('Permanent', 'Transient')
    expect(await sesProvider.handleWebhook(creds(), webhook('events', msg))).toEqual({ type: 'rejected', reason: 'Invalid SNS signature' })
  })

  it('rejects a certificate that isn\'t on an Amazon SNS host', async () => {
    const msg = snsMessage({ Type: 'Notification', Message: bounce })
    expect(await sesProvider.handleWebhook(creds(), webhook('events', msg))).toMatchObject({ type: 'rejected', reason: expect.stringContaining('signing certificate') })
    for (const url of ['https://evil.example.com/cert.pem', 'https://sns.us-east-1.amazonaws.com.evil.com/cert.pem', 'http://sns.us-east-1.amazonaws.com/cert.pem']) {
      const forged = snsMessage({ Type: 'Notification', Message: bounce, SigningCertURL: url })
      expect(await sesProvider.handleWebhook(creds(), webhook('events', forged))).toMatchObject({ type: 'rejected' })
    }
    expect(seen).toHaveLength(0)
    expect(isAwsSnsUrl(new URL('https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem'))).toBe(true)
    expect(isAwsSnsUrl(new URL('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc.pem'))).toBe(true)
  })

  it('rejects a SubscribeURL that isn\'t on an Amazon SNS host', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    const msg = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'confirm', Token: 'tok', SubscribeURL: `${endpoint}/confirm?Token=tok` })
    expect(await sesProvider.handleWebhook(creds(), webhook('events', msg))).toEqual({ type: 'rejected', reason: 'The SubscribeURL isn\'t on an Amazon SNS host' })
    expect(seen.some(s => s.path.startsWith('/confirm'))).toBe(false)
  })

  it('confirms a subscription', async () => {
    __setSnsUrlCheck(allowLocal('both'))
    const msg = snsMessage({ Type: 'SubscriptionConfirmation', Message: 'confirm', Token: 'tok', SubscribeURL: `${endpoint}/confirm?Token=tok` })
    expect(await sesProvider.handleWebhook(creds(), webhook('events', msg))).toEqual({ type: 'handshake', response: { status: 'confirmed' } })
    expect(seen.some(s => s.path === '/confirm?Token=tok')).toBe(true)
  })
})

describe('inbound', () => {
  const raw = Buffer.from([
    'From: Sender <sender@example.com>',
    'To: hello@in.example.org',
    'Subject: Inbound test',
    'Message-ID: <in-1@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hello there.',
    ''
  ].join('\r\n'))

  const INBOUND_TOPIC = `arn:aws:sns:${REGION}:123456789012:nx-in-example-org-inbound`

  function received(action: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      notificationType: 'Received',
      mail: { source: 'bounce@example.com', destination: ['hello@in.example.org'], messageId: 'ses-in-1' },
      receipt: { recipients: ['hello@in.example.org'], action },
      ...extra
    })
  }

  it('fetches the message from S3 and parses it', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    objects.set('/inbox-bucket/nx-inbound/in.example.org/ses-in-1', raw)
    const msg = snsMessage({ Type: 'Notification', TopicArn: INBOUND_TOPIC, Message: received({ type: 'S3', bucketName: 'inbox-bucket', objectKey: 'nx-inbound/in.example.org/ses-in-1' }) })
    const res = await sesProvider.handleWebhook(creds({ inboundBucket: 'inbox-bucket' }), webhook('inbound', msg))
    expect(res.type).toBe('inbound')
    if (res.type !== 'inbound') return
    expect(res.mail.subject).toBe('Inbound test')
    expect(res.mail.envelopeTo).toEqual(['hello@in.example.org'])
    expect(res.mail.envelopeFrom).toBe('bounce@example.com')
    expect(res.mail.text?.trim()).toBe('Hello there.')
    const get = seen.find(s => s.service === 's3')!
    expect(get.signatureValid).toBe(true)
    expect(get.headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('refuses a bucket the account doesn\'t receive into', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    const msg = snsMessage({ Type: 'Notification', TopicArn: INBOUND_TOPIC, Message: received({ type: 'S3', bucketName: 'someone-else', objectKey: 'x' }) })
    expect(await sesProvider.handleWebhook(creds({ inboundBucket: 'inbox-bucket' }), webhook('inbound', msg))).toMatchObject({ type: 'rejected' })
    expect(seen.some(s => s.service === 's3')).toBe(false)
  })

  it('throws when S3 fails, so SNS retries', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    const msg = snsMessage({ Type: 'Notification', TopicArn: INBOUND_TOPIC, Message: received({ type: 'S3', bucketName: 'inbox-bucket', objectKey: 'missing' }) })
    await expect(sesProvider.handleWebhook(creds(), webhook('inbound', msg))).rejects.toThrow(/S3 responded 404/)
  })

  it('parses content carried inline by an SNS action', async () => {
    __setSnsUrlCheck(allowLocal('cert'))
    const msg = snsMessage({ Type: 'Notification', TopicArn: INBOUND_TOPIC, Message: received({ type: 'SNS', encoding: 'BASE64' }, { content: raw.toString('base64') }) })
    const res = await sesProvider.handleWebhook(creds(), webhook('inbound', msg))
    expect(res).toMatchObject({ type: 'inbound', mail: { subject: 'Inbound test', envelopeTo: ['hello@in.example.org'] } })
  })
})
