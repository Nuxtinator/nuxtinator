// The Mailgun adapter against a local fake of Mailgun's HTTP API. Kernel-level
// cases run createMail with the real adapter on the `mail` project's schema.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mailgunProvider, mapMailgunEvent } from '../adapters/mailgun'
import { __setEndpointCheck } from '../adapters/http'
import { createMail, memoryDns, type MailAccountRow, type MailStream, type ProviderMessage, type WebhookRequest } from '../kernel'
import { db, resetTables, SECRET } from './helpers'

interface Seen {
  method: string
  path: string
  auth: string | null
  contentType: string
  raw: Buffer
}
type Reply = { status: number, body?: unknown }

const seen: Seen[] = []
let reply: (req: Seen) => Reply = () => ({ status: 200, body: {} })
let server: Server
let endpoint = ''

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const s: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        auth: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? '',
        raw: Buffer.concat(chunks)
      }
      seen.push(s)
      const r = reply(s)
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body === undefined ? '' : JSON.stringify(r.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  __setEndpointCheck(url => url.hostname === '127.0.0.1')
})

afterAll(async () => {
  __setEndpointCheck(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  await db().destroy()
})

beforeEach(() => {
  seen.length = 0
  reply = () => ({ status: 200, body: {} })
})

const SIGNING_PATH = '/v5/accounts/http_signing_key'
const basic = (key: string) => `Basic ${Buffer.from(`api:${key}`).toString('base64')}`
const calls = () => seen.map(s => `${s.method} ${s.path}`)

type Field = string | { filename: string, type: string, content: string }

async function formEntries(s: Seen): Promise<[string, Field][]> {
  if (s.contentType.includes('multipart/form-data')) {
    const form = await new Response(new Uint8Array(s.raw), { headers: { 'content-type': s.contentType } }).formData()
    const out: [string, Field][] = []
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') out.push([k, v])
      else out.push([k, { filename: v.name, type: v.type, content: Buffer.from(await v.arrayBuffer()).toString('utf8') }])
    }
    return out
  }
  return [...new URLSearchParams(s.raw.toString('utf8')).entries()]
}

async function fields(s: Seen): Promise<Record<string, Field>> {
  return Object.fromEntries(await formEntries(s))
}

const SIGNING_KEY = 'mg-signing-key'

function sign(key = SIGNING_KEY, timestamp = String(Math.floor(Date.now() / 1000)), token = 'tok-123') {
  return { timestamp, token, signature: createHmac('sha256', key).update(timestamp + token).digest('hex') }
}

const account = {} as MailAccountRow

function message(extra: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    from: { name: 'App "Mail"', address: 'noreply@mg.example.org' },
    domain: 'mg.example.org',
    to: 'person@example.com',
    replyTo: null,
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    messageId: '<abc@mg.example.org>',
    headers: { 'Message-Id': '<abc@mg.example.org>' },
    attachments: [],
    correlation: { stream: 'account', orgId: null, ref: null },
    bypassProviderSuppression: false,
    signal: new AbortController().signal,
    ...extra
  }
}

describe('send', () => {
  it('posts the form fields Mailgun expects, with headers, correlation variables and inline parts', async () => {
    reply = () => ({ status: 200, body: { id: '<mg-id@mg.example.org>', message: 'Queued' } })
    const res = await mailgunProvider.send({ apiKey: 'key-acct', host: endpoint }, message({
      replyTo: 'reply@example.org',
      headers: { 'Message-Id': '<abc@mg.example.org>', 'List-Unsubscribe': '<https://app.test/u>' },
      correlation: { stream: 'system', orgId: 'org-1', ref: 'ref-1' },
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') },
        { filename: 'logo.png', contentType: 'image/png', data: Buffer.from('png-bytes'), cid: 'logo-cid' }
      ]
    }))
    expect(res).toEqual({ status: 'sent', providerMessageId: '<mg-id@mg.example.org>', messageId: '<abc@mg.example.org>' })
    expect(calls()).toEqual(['POST /v3/mg.example.org/messages'])
    expect(seen[0]!.auth).toBe(basic('key-acct'))
    expect(await formEntries(seen[0]!)).toEqual([
      ['from', '"App \'Mail\'" <noreply@mg.example.org>'],
      ['to', 'person@example.com'],
      ['subject', 'Hello'],
      ['html', '<p>Hi</p>'],
      ['text', 'Hi'],
      ['h:Reply-To', 'reply@example.org'],
      ['h:Message-Id', '<abc@mg.example.org>'],
      ['h:List-Unsubscribe', '<https://app.test/u>'],
      ['v:nx-stream', 'system'],
      ['v:nx-org', 'org-1'],
      ['v:nx-ref', 'ref-1'],
      ['o:suppress-headers', 'X-Mailgun-Variables'],
      ['attachment', { filename: 'a.txt', type: 'text/plain', content: 'hello' }],
      ['inline', { filename: 'logo-cid', type: 'image/png', content: 'png-bytes' }]
    ])
  })

  it('leaves out org and ref when there are none, and sends with the domain key over the account key', async () => {
    reply = () => ({ status: 200, body: { id: 'x' } })
    await mailgunProvider.send({ apiKey: 'key-acct', sendingKey: 'key-domain', host: endpoint }, message())
    expect(seen[0]!.auth).toBe(basic('key-domain'))
    const f = await fields(seen[0]!)
    expect(f['v:nx-stream']).toBe('account')
    expect(f['v:nx-org']).toBeUndefined()
    expect(f['v:nx-ref']).toBeUndefined()
    expect(f['o:testmode']).toBeUndefined()
  })

  it('maps failures: 401/403 reject the key, 429/5xx retry, other 4xx do not', async () => {
    const creds = { apiKey: 'k', host: endpoint }
    reply = () => ({ status: 401 })
    expect(await mailgunProvider.send(creds, message())).toMatchObject({ status: 'failed', retryable: false, keyRejected: true })
    reply = () => ({ status: 403 })
    expect(await mailgunProvider.send(creds, message())).toMatchObject({ status: 'failed', retryable: false, keyRejected: true })
    reply = () => ({ status: 429 })
    expect(await mailgunProvider.send(creds, message())).toMatchObject({ status: 'failed', retryable: true })
    reply = () => ({ status: 502 })
    expect(await mailgunProvider.send(creds, message())).toMatchObject({ status: 'failed', retryable: true })
    reply = () => ({ status: 400, body: { message: 'bad to' } })
    expect(await mailgunProvider.send(creds, message())).toMatchObject({ status: 'failed', retryable: false })
    expect(await mailgunProvider.send({ host: endpoint }, message())).toMatchObject({ status: 'failed', keyRejected: true })
  })
})

describe('event webhook signatures', () => {
  const payload = (signature: unknown) => Buffer.from(JSON.stringify({
    signature,
    'event-data': { event: 'delivered', recipient: 'A@x.test', timestamp: 1700000000, message: { headers: { 'message-id': 'm1@mg' } } }
  }))
  const handle = (rawBody: Buffer, key = SIGNING_KEY) =>
    mailgunProvider.handleWebhook(key ? { webhookSigningKey: key } : {}, { kind: 'events', headers: { 'Content-Type': 'application/json' }, rawBody, account })

  it('accepts a correctly signed event', async () => {
    const res = await handle(payload(sign()))
    expect(res).toMatchObject({ type: 'events', events: [{ type: 'delivered', recipient: 'A@x.test', providerMessageId: 'm1@mg' }] })
  })

  it('rejects a bad, missing or stale signature, and a missing signing key', async () => {
    expect(await handle(payload({ ...sign(), signature: 'f'.repeat(64) }))).toEqual({ type: 'rejected', reason: 'Invalid signature' })
    expect(await handle(payload(sign('another-key')))).toEqual({ type: 'rejected', reason: 'Invalid signature' })
    expect(await handle(payload({ timestamp: sign().timestamp, token: 'tok' }))).toEqual({ type: 'rejected', reason: 'Missing signature' })
    expect(await handle(Buffer.from(JSON.stringify({ 'event-data': { event: 'delivered' } })))).toEqual({ type: 'rejected', reason: 'Missing signature' })
    const now = Math.floor(Date.now() / 1000)
    expect(await handle(payload(sign(SIGNING_KEY, String(now - 16 * 60))))).toEqual({ type: 'rejected', reason: 'Stale signature' })
    expect(await handle(payload(sign(SIGNING_KEY, String(now + 16 * 60))))).toEqual({ type: 'rejected', reason: 'Stale signature' })
    expect((await handle(payload(sign(SIGNING_KEY, String(now - 14 * 60))))).type).toBe('events')
    expect(await handle(payload(sign()), '')).toEqual({ type: 'rejected', reason: 'No webhook signing key is set for this account' })
    expect(await handle(Buffer.from('not json'))).toEqual({ type: 'rejected', reason: 'Malformed payload' })
  })
})

describe('event mapping', () => {
  const map = (e: Record<string, unknown>) => mapMailgunEvent({ recipient: 'a@x.test', timestamp: 1700000000, ...e })

  it('permanent failed is a permanent bounce; temporary is a deferral', () => {
    expect(map({ event: 'failed', severity: 'permanent', reason: 'bounce', 'delivery-status': { message: '550 no such user' } }))
      .toMatchObject({ type: 'bounced', permanent: true, detail: '550 no such user', occurredAt: new Date(1700000000 * 1000) })
    expect(map({ event: 'failed', severity: 'temporary', reason: 'generic' })).toMatchObject({ type: 'deferred', permanent: false })
  })

  it('complained and unsubscribed', () => {
    expect(map({ event: 'complained' })?.type).toBe('complained')
    expect(map({ event: 'unsubscribed' })?.type).toBe('unsubscribed')
  })

  it('a failure caused by Mailgun\'s own list is dropped, with that list', () => {
    expect(map({ event: 'failed', severity: 'permanent', reason: 'suppress-bounce' })).toMatchObject({ type: 'dropped', list: 'bounce' })
    expect(map({ event: 'failed', severity: 'permanent', reason: 'suppress-complaint' })).toMatchObject({ type: 'dropped', list: 'complaint' })
    expect(map({ event: 'failed', severity: 'permanent', reason: 'suppress-unsubscribe' })).toMatchObject({ type: 'dropped', list: 'unsubscribe' })
    expect(map({ event: 'failed', severity: 'permanent', reason: 'bounce' })?.list).toBeUndefined()
  })

  it('carries the correlation variables and the sending domain', () => {
    const e = map({
      event: 'delivered',
      'user-variables': { 'nx-stream': 'system', 'nx-org': 'org-1', 'nx-ref': 'ref-1' },
      envelope: { sender: 'bounce+abc@MG.Example.org' }
    })
    expect(e).toMatchObject({ type: 'delivered', stream: 'system', orgId: 'org-1', ref: 'ref-1', domain: 'mg.example.org' })
    expect(map({ event: 'accepted' })).toBeNull()
  })
})

const MIME = [
  'From: Sender <sender@outside.test>',
  'To: list@outside.test',
  'Subject: Raw hello',
  'Message-ID: <raw-1@outside.test>',
  'Authentication-Results: mx.mailgun.org; dkim=pass header.d=outside.test; spf=pass smtp.mailfrom=outside.test; dmarc=pass (p=none) header.from=outside.test',
  'X-Mailgun-Sscore: 0.5',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello <img src="cid:logo@outside.test"></p>',
  '--rel',
  'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-ID: <logo@outside.test>',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('png-bytes').toString('base64'),
  '--rel--',
  '--mix',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  '',
  'attached text',
  '--mix--',
  ''
].join('\r\n')

describe('inbound raw MIME', () => {
  function inboundFields(extra: Record<string, string> = {}): Record<string, string> {
    return { recipient: 'hello@mg.example.org, sales@mg.example.org', sender: 'bounce@outside.test', 'body-mime': MIME, ...sign(), ...extra }
  }
  const handle = (rawBody: Buffer, contentType: string) =>
    mailgunProvider.handleWebhook({ webhookSigningKey: SIGNING_KEY }, { kind: 'inbound', variant: 'mime', headers: { 'Content-Type': contentType }, rawBody, account } satisfies WebhookRequest)

  async function multipart(f: Record<string, string>) {
    const form = new FormData()
    for (const [k, v] of Object.entries(f)) form.append(k, v)
    const encoded = new Response(form)
    return { body: Buffer.from(await encoded.arrayBuffer()), type: encoded.headers.get('content-type')! }
  }

  function expectParsed(res: Awaited<ReturnType<typeof handle>>) {
    if (res.type !== 'inbound') throw new Error(`expected inbound, got ${JSON.stringify(res)}`)
    const mail = res.mail
    expect(mail.envelopeTo).toEqual(['hello@mg.example.org', 'sales@mg.example.org'])
    expect(mail.to).toEqual(['list@outside.test'])
    expect(mail.envelopeFrom).toBe('bounce@outside.test')
    expect(mail.messageId).toBe('<raw-1@outside.test>')
    expect(mail.from).toEqual({ address: 'sender@outside.test', name: 'Sender' })
    expect(mail.subject).toBe('Raw hello')
    expect(mail.html).toContain('cid:logo@outside.test')
    expect(mail.authentication).toEqual({ dmarc: 'pass', dkim: [{ domain: 'outside.test', result: 'pass' }], spf: 'pass' })
    expect(mail.spamScore).toBe(0.5)
    const inline = mail.attachments.find(a => a.cid === 'logo@outside.test')
    expect(inline).toMatchObject({ filename: 'logo.png', contentType: 'image/png', inline: true })
    expect(inline!.data.toString('utf8')).toBe('png-bytes')
    const file = mail.attachments.find(a => a.filename === 'notes.txt')
    expect(file).toMatchObject({ contentType: 'text/plain', inline: false, cid: null })
    expect(file!.data.toString('utf8').trim()).toBe('attached text')
  }

  it('parses an urlencoded forward', async () => {
    const body = Buffer.from(new URLSearchParams(inboundFields()).toString())
    expectParsed(await handle(body, 'application/x-www-form-urlencoded'))
  })

  it('parses a multipart forward', async () => {
    const { body, type } = await multipart(inboundFields())
    expectParsed(await handle(body, type))
  })

  it('a reported DMARC fail and a DKIM fail come through as such', async () => {
    const failing = MIME.replace('dkim=pass header.d=outside.test; spf=pass smtp.mailfrom=outside.test; dmarc=pass (p=none)', 'dkim=fail header.d=other.test; spf=softfail; dmarc=fail (p=reject)')
    const body = Buffer.from(new URLSearchParams(inboundFields({ 'body-mime': failing })).toString())
    const res = await handle(body, 'application/x-www-form-urlencoded')
    if (res.type !== 'inbound') throw new Error('expected inbound')
    expect(res.mail.authentication).toEqual({ dmarc: 'fail', dkim: [{ domain: 'other.test', result: 'fail' }], spf: 'softfail' })
  })

  it('rejects a bad, missing or stale signature, and a parsed (not raw) forward', async () => {
    const enc = (f: Record<string, string>) => Buffer.from(new URLSearchParams(f).toString())
    const type = 'application/x-www-form-urlencoded'
    expect(await handle(enc(inboundFields({ signature: '0'.repeat(64) })), type)).toEqual({ type: 'rejected', reason: 'Invalid signature' })
    const { signature: _s, ...unsigned } = inboundFields()
    expect(await handle(enc(unsigned), type)).toEqual({ type: 'rejected', reason: 'Missing signature' })
    const stale = sign(SIGNING_KEY, String(Math.floor(Date.now() / 1000) - 20 * 60))
    expect(await handle(enc(inboundFields(stale)), type)).toEqual({ type: 'rejected', reason: 'Stale signature' })
    const { 'body-mime': _m, ...parsed } = inboundFields({ 'body-plain': 'parsed mode' })
    expect((await handle(enc(parsed), type)).type).toBe('rejected')
    const multi = await multipart(inboundFields({ signature: '0'.repeat(64) }))
    expect(await handle(multi.body, multi.type)).toEqual({ type: 'rejected', reason: 'Invalid signature' })
  })
})

describe('verifyCredentials', () => {
  it('a domain sending key: send only, and the probe is a test-mode send that delivers nothing', async () => {
    const res = await mailgunProvider.verifyCredentials({ sendingKey: 'key-domain', host: endpoint }, 'mg.example.org', { probeAddress: 'nx-probe-abc@mg.example.org' })
    expect(res).toEqual({ ok: true, capabilities: { send: true, domains: false, routes: false, webhooks: false, suppressionLists: false } })
    expect(calls()).toEqual(['POST /v3/mg.example.org/messages'])
    expect(seen[0]!.auth).toBe(basic('key-domain'))
    const f = await fields(seen[0]!)
    expect(f).toMatchObject({ 'o:testmode': 'yes', 'to': 'nx-probe-abc@mg.example.org', 'v:nx-stream': 'nx-probe' })
  })

  it('a domain sending key entered as the account key behaves the same', async () => {
    reply = s => ({ status: s.path.startsWith('/v4/domains') ? 401 : 200 })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-domain', host: endpoint }, 'mg.example.org')
    expect(res).toEqual({ ok: true, capabilities: { send: true, domains: false, routes: false, webhooks: false, suppressionLists: false } })
    expect((await fields(seen.find(s => s.method === 'POST')!))['o:testmode']).toBe('yes')
  })

  it('an account key that isn\'t Admin: send and suppression lists are proven; domains, routes and webhooks are refused', async () => {
    reply = s => ({ status: s.path.includes('/bounces/') ? 404 : s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-acct', host: endpoint }, 'mg.example.org')
    expect(res).toEqual({ ok: true, capabilities: { send: true, suppressionLists: true, domains: false, routes: false, webhooks: false } })
    expect(calls().map(c => c.replace(/nx-probe-none-\d+/, 'X'))).toEqual([
      'GET /v4/domains?limit=1',
      `GET ${SIGNING_PATH}`,
      'POST /v3/mg.example.org/messages',
      'GET /v3/mg.example.org/bounces/X%40mg.example.org'
    ])
  })

  it('an Admin key: domains, routes and webhooks are allowed, and the signing key is read', async () => {
    reply = s => ({ status: s.path.includes('/bounces/') ? 404 : 200, body: s.path === SIGNING_PATH ? { http_signing_key: 'sig-from-api' } : {} })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-admin', host: endpoint }, 'mg.example.org')
    expect(res).toEqual({
      ok: true,
      capabilities: { send: true, suppressionLists: true, domains: true, routes: true, webhooks: true },
      credentials: { webhookSigningKey: 'sig-from-api' }
    })
  })

  it('a key refused on the suppression list records it as false', async () => {
    reply = s => ({ status: s.path.includes('/bounces/') || s.path === SIGNING_PATH ? 403 : 200, body: {} })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-acct', host: endpoint }, 'mg.example.org')
    expect(res).toMatchObject({ ok: true, capabilities: { send: true, suppressionLists: false } })
  })

  it('with no domain, only the domain-free probes run', async () => {
    reply = s => ({ status: s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-acct', host: endpoint })
    expect(res).toEqual({ ok: true, capabilities: { domains: false, routes: false, webhooks: false } })
    expect(calls()).toEqual(['GET /v4/domains?limit=1', `GET ${SIGNING_PATH}`])
  })

  it('a sending key beside an account key: send is the sending key\'s, the rest the account key\'s', async () => {
    reply = s => ({ status: s.path.includes('/bounces/') ? 404 : s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const res = await mailgunProvider.verifyCredentials({ apiKey: 'key-acct', sendingKey: 'key-domain', host: endpoint }, 'mg.example.org')
    expect(res).toEqual({ ok: true, capabilities: { send: true, suppressionLists: true, domains: false, routes: false, webhooks: false } })
    expect(seen.find(s => s.method === 'POST')!.auth).toBe(basic('key-domain'))
    expect(seen.filter(s => s.method === 'GET').every(s => s.auth === basic('key-acct'))).toBe(true)

    seen.length = 0
    reply = s => ({ status: s.method === 'GET' ? 401 : 200, body: {} })
    const refusedAccount = await mailgunProvider.verifyCredentials({ apiKey: 'bad', sendingKey: 'key-domain', host: endpoint }, 'mg.example.org')
    expect(refusedAccount).toEqual({ ok: true, capabilities: { send: true, domains: false, routes: false, webhooks: false, suppressionLists: false } })
  })

  it('accepts only an https host of Mailgun\'s own', async () => {
    __setEndpointCheck(null)
    try {
      for (const host of ['169.254.169.254', 'http://api.mailgun.net', 'https://evil.example.com', 'api.mailgun.net.evil.com', 'api.mailgun.net:8080']) {
        expect(await mailgunProvider.verifyCredentials({ apiKey: 'k', host }, 'mg.example.org')).toMatchObject({ ok: false, error: expect.stringContaining('https URL') })
        expect(await mailgunProvider.send({ apiKey: 'k', host }, message())).toMatchObject({ status: 'failed', retryable: false })
      }
      expect(seen).toHaveLength(0)
    } finally {
      __setEndpointCheck(url => url.hostname === '127.0.0.1')
    }
  })

  it('a rejected key fails; a signing key alone is accepted with nothing proven', async () => {
    reply = () => ({ status: 401 })
    expect(await mailgunProvider.verifyCredentials({ apiKey: 'bad', host: endpoint }, 'mg.example.org')).toEqual({ ok: false, error: 'Mailgun rejected the key' })
    seen.length = 0
    expect(await mailgunProvider.verifyCredentials({ webhookSigningKey: 'sig', host: endpoint })).toEqual({ ok: true, capabilities: {} })
    expect(seen).toHaveLength(0)
  })
})

describe('provider suppression', () => {
  it('mode follows suppressionLists', () => {
    expect(mailgunProvider.providerSuppression.mode({ suppressionLists: true })).toBe('mirrored')
    expect(mailgunProvider.providerSuppression.mode({ suppressionLists: false })).toBe('unmanaged')
    expect(mailgunProvider.providerSuppression.mode({})).toBe('unmanaged')
  })

  it('release deletes from the matching list and tolerates 404', async () => {
    reply = s => ({ status: s.path.includes('/complaints/') ? 404 : 200 })
    const release = mailgunProvider.providerSuppression.release!
    const creds = { apiKey: 'key-acct', host: endpoint }
    await release(creds, 'mg.example.org', 'a+b@x.test', 'bounce')
    await release(creds, 'mg.example.org', 'a+b@x.test', 'complaint')
    await release(creds, 'mg.example.org', 'a+b@x.test', 'unsubscribe')
    expect(calls()).toEqual([
      'DELETE /v3/mg.example.org/bounces/a%2Bb%40x.test',
      'DELETE /v3/mg.example.org/complaints/a%2Bb%40x.test',
      'DELETE /v3/mg.example.org/unsubscribes/a%2Bb%40x.test'
    ])
    expect(seen.every(s => s.auth === basic('key-acct'))).toBe(true)
    reply = () => ({ status: 500 })
    await expect(release(creds, 'mg.example.org', 'a@x.test', 'bounce')).rejects.toThrow(/500/)
  })
})

describe('configureWebhooks', () => {
  const urls = { events: 'https://app.test/api/mail/webhooks/acct/tok/events', inbound: 'https://app.test/i', inboundMime: 'https://app.test/i/mime' }
  const base = ['bounced', 'complained', 'unsubscribed', 'rejected', 'dropped'] as const

  async function subscribed() {
    const out: Record<string, string[]> = {}
    for (const s of seen.filter(s => s.method === 'POST' || s.method === 'PUT')) {
      const entries = await formEntries(s)
      const kind = s.method === 'POST' ? String(entries.find(([k]) => k === 'id')![1]) : s.path.split('/').pop()!
      out[kind] = entries.filter(([k]) => k === 'url').map(([, v]) => String(v))
    }
    return out
  }

  it('subscribes exactly the kinds for the event list, without delivered unless asked', async () => {
    reply = s => ({ status: 200, body: s.method === 'GET' ? { webhooks: {} } : {} })
    await mailgunProvider.configureWebhooks!({ apiKey: 'k', host: endpoint }, 'mg.example.org', urls, { delivered: false, events: [...base] })
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v3/domains/mg.example.org/webhooks' })
    expect(await subscribed()).toEqual({ permanent_fail: [urls.events], complained: [urls.events], unsubscribed: [urls.events] })
  })

  it('adds delivered when asked', async () => {
    reply = s => ({ status: 200, body: s.method === 'GET' ? { webhooks: {} } : {} })
    await mailgunProvider.configureWebhooks!({ apiKey: 'k', host: endpoint }, 'mg.example.org', urls, { delivered: true, events: ['delivered', ...base] })
    expect(Object.keys(await subscribed()).sort()).toEqual(['complained', 'delivered', 'permanent_fail', 'unsubscribed'])
  })

  it('keeps other apps\' URLs, leaves current ones alone and drops ours from kinds no longer wanted', async () => {
    reply = s => ({
      status: 200,
      body: s.method === 'GET'
        ? { webhooks: {
            delivered: { urls: [urls.events] },
            complained: { urls: ['https://other.example/hook'] },
            permanent_fail: { urls: [urls.events] },
            temporary_fail: { urls: [urls.events, 'https://other.example/hook'] }
          } }
        : {}
    })
    await mailgunProvider.configureWebhooks!({ apiKey: 'k', host: endpoint }, 'mg.example.org', urls, { delivered: false, events: [...base] })
    expect(calls().slice(1).sort()).toEqual([
      'DELETE /v3/domains/mg.example.org/webhooks/delivered',
      'POST /v3/domains/mg.example.org/webhooks',
      'PUT /v3/domains/mg.example.org/webhooks/complained',
      'PUT /v3/domains/mg.example.org/webhooks/temporary_fail'
    ])
    const sub = await subscribed()
    expect(sub.complained).toEqual(['https://other.example/hook', urls.events])
    expect(sub.unsubscribed).toEqual([urls.events])
    expect(sub.temporary_fail).toEqual(['https://other.example/hook'])
  })

  it('a refused key is a permission error', async () => {
    reply = () => ({ status: 403 })
    await expect(mailgunProvider.configureWebhooks!({ apiKey: 'k', host: endpoint }, 'mg.example.org', urls, { delivered: false, events: [...base] }))
      .rejects.toMatchObject({ capability: 'webhooks' })
  })
})

describe('with the kernel', () => {
  const STREAMS: MailStream[] = [
    { id: 'system', label: 'System', defaultLocal: 'noreply', orgAssignable: false }
  ]
  const BASE = 'https://app.test'

  function kernel() {
    return createMail({
      db: db(),
      providers: [mailgunProvider],
      streams: STREAMS,
      env: {},
      secretKey: SECRET,
      transport: 'provider',
      dns: memoryDns(),
      log: () => {}
    })
  }

  beforeEach(resetTables)

  const accountRow = (id: string) => db().selectFrom('mail_accounts').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  const domainRow = (id: string) => db().selectFrom('mail_domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  it('a key that can read but isn\'t Admin: known refused after verify, so an automatic add writes nothing and falls back to manual steps', async () => {
    reply = s => ({ status: s.method === 'GET' && s.path !== SIGNING_PATH ? 200 : 403, body: {} })
    const mail = kernel()
    const { account, verify } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-read', host: endpoint, webhookSigningKey: SIGNING_KEY } })
    expect(verify).toEqual({ ok: true, capabilities: { domains: false, routes: false, webhooks: false } })
    expect(account.capabilities).toEqual({ domains: false, routes: false, webhooks: false })

    const added = await mail.admin.addDomain({ orgId: null }, { domain: 'mg.example.org', sendAccountId: account.id, setupMode: 'auto' }, BASE)
    expect(calls()).not.toContain('POST /v4/domains')
    expect(added.setup?.roles).toEqual([{ role: 'send', mode: 'manual', error: expect.any(String) }])
    expect(added.domain.setup_mode).toBe('manual')
    expect((await accountRow(account.id)).capabilities).toMatchObject({ domains: false })

    const steps = mail.admin.manualSteps(await accountRow(account.id), added.domain, 'send', mail.webhookUrls(account, BASE), await mail.admin.requiredEvents(added.domain))
    expect(steps.length).toBeGreaterThan(0)
    expect(JSON.stringify(steps)).toContain(mail.webhookUrls(account, BASE).events)
  })

  it('an account with only a signing key, plus a domain sending key, sends', async () => {
    reply = () => ({ status: 200, body: { id: '<sent-1@mg>' } })
    const mail = kernel()
    const { account, verify } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { webhookSigningKey: SIGNING_KEY, host: endpoint } })
    expect(verify).toEqual({ ok: true, capabilities: {} })
    expect(seen).toHaveLength(0)

    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'mg.example.org', sendAccountId: account.id, setupMode: 'manual', credentials: { sendingKey: 'key-domain' } }, BASE)
    const check = await mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    expect(check.roles[0]).toMatchObject({ role: 'send', status: 'verified' })
    await mail.admin.setStreamRoute({ orgId: null }, 'system', domain.id, BASE)

    seen.length = 0
    const res = await mail.send({ stream: 'system', to: 'person@example.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(res).toMatchObject({ status: 'sent', domain: 'mg.example.org', providerMessageId: '<sent-1@mg>' })
    expect(calls()).toEqual(['POST /v3/mg.example.org/messages'])
    expect(seen[0]!.auth).toBe(basic('key-domain'))
    expect((await fields(seen[0]!))['o:testmode']).toBeUndefined()
  })

  it('a domain with its own key gets its own capabilities, probed against it, and its suppression mode follows them', async () => {
    // The account key may read shared.example.org's lists but not own.example.org's.
    reply = s => ({ status: s.path.includes('/own.example.org/bounces/') || s.path === SIGNING_PATH ? 403 : s.path.includes('/bounces/') ? 404 : 200, body: {} })
    const mail = kernel()
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-acct', host: endpoint, webhookSigningKey: SIGNING_KEY } })
    const shared = await mail.admin.addDomain({ orgId: null }, { domain: 'shared.example.org', sendAccountId: account.id, setupMode: 'manual' }, BASE)
    await mail.admin.verifyAccount({ orgId: null }, account.id)
    expect((await accountRow(account.id)).capabilities).toEqual({ send: true, suppressionLists: true, domains: false, routes: false, webhooks: false })

    const own = await mail.admin.addDomain({ orgId: null }, { domain: 'own.example.org', sendAccountId: account.id, setupMode: 'manual' }, BASE)
    seen.length = 0
    await mail.admin.patchDomain({ orgId: null }, own.domain.id, { credentials: { sendingKey: 'key-own' } }, BASE)
    const probe = seen.find(s => s.method === 'POST')!
    expect(probe.path).toBe('/v3/own.example.org/messages')
    expect(probe.auth).toBe(basic('key-own'))
    expect((await fields(probe))['o:testmode']).toBe('yes')
    expect(seen.find(s => s.path.includes('/own.example.org/bounces/'))!.auth).toBe(basic('key-acct'))
    const ownCaps = (await domainRow(own.domain.id)).capabilities!
    expect(ownCaps).toMatchObject({ send: true, suppressionLists: false })
    expect(mailgunProvider.providerSuppression.mode(ownCaps)).toBe('unmanaged')
    expect((await domainRow(shared.domain.id)).capabilities).toBeNull()

    // A complaint is released from Mailgun's list on the mirrored domain only.
    seen.length = 0
    const complaint = (domain: string, recipient: string) => ({
      type: 'complained' as const, permanent: false, recipient, providerMessageId: null, occurredAt: new Date(), detail: null, stream: null, orgId: null, ref: null, domain
    })
    const acct = await accountRow(account.id)
    await mail.handleEvents(acct, [complaint('own.example.org', 'one@x.test'), complaint('shared.example.org', 'two@x.test')])
    expect(calls()).toEqual(['DELETE /v3/shared.example.org/complaints/two%40x.test'])
  })

  it('a domain added with its own key is probed when it is added', async () => {
    reply = s => ({ status: s.path.includes('/bounces/') ? 404 : s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const mail = kernel()
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-acct', host: endpoint } })
    seen.length = 0
    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'own.example.org', sendAccountId: account.id, setupMode: 'manual', credentials: { sendingKey: 'key-own' } }, BASE)
    expect(seen.find(s => s.method === 'POST')).toMatchObject({ path: '/v3/own.example.org/messages', auth: basic('key-own') })
    // The account key still serves the domain for everything but sending, so its capabilities count.
    expect(domain.capabilities).toMatchObject({ send: true, suppressionLists: true })
    expect(mailgunProvider.providerSuppression.mode(domain.capabilities!)).toBe('mirrored')
  })

  it('an account verified with no domain records only the domain-free probes', async () => {
    reply = s => ({ status: s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const mail = kernel()
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-acct', host: endpoint } })
    expect(calls()).toEqual(['GET /v4/domains?limit=1', `GET ${SIGNING_PATH}`])
    expect(account.capabilities).toEqual({ domains: false, routes: false, webhooks: false })
  })

  it('a sending key on the domain beside an account holding only the signing key: a refused one is recorded, a good one reads the setup', async () => {
    const mail = kernel()
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { webhookSigningKey: SIGNING_KEY, host: endpoint } })
    reply = () => ({ status: 401 })
    const refused = await mail.admin.addDomain({ orgId: null }, { domain: 'bad.example.org', sendAccountId: account.id, setupMode: 'manual', credentials: { sendingKey: 'key-wrong' } }, BASE)
    expect(refused.domain.capabilities).toEqual({ send: false })

    reply = s => ({ status: s.path.startsWith('/v4/domains/good.example.org') ? 200 : s.method === 'POST' ? 200 : 401, body: {} })
    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'good.example.org', sendAccountId: account.id, setupMode: 'manual', credentials: { sendingKey: 'key-domain' } }, BASE)
    expect(domain.capabilities).toMatchObject({ send: true })
    seen.length = 0
    const check = await mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    expect(check.roles[0]!.checks).toContainEqual(expect.objectContaining({ key: 'provider-domain', ok: true }))
    expect(seen.find(s => s.path === '/v4/domains/good.example.org')!.auth).toBe(basic('key-domain'))
    expect(mail.admin.domainKeyView(await accountRow(account.id), await domainRow(domain.id))).toEqual({ sendingKey: expect.stringMatching(/^•+/) })
  })

  it('an Admin key stores the signing key it reads, so nobody has to paste it', async () => {
    reply = s => ({ status: 200, body: s.path === SIGNING_PATH ? { http_signing_key: 'sig-from-api' } : {} })
    const mail = kernel()
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-admin', host: endpoint } })
    expect(mail.admin.accountView(await accountRow(account.id)).credentials).toMatchObject({ webhookSigningKey: expect.any(String) })
    expect(account.capabilities).toMatchObject({ domains: true, routes: true, webhooks: true })
  })

  it('checking a domain set up by hand reads the domain, webhooks and routes, and ticks off the steps that are done', async () => {
    const mail = kernel()
    reply = s => ({ status: s.path === SIGNING_PATH ? 401 : 200, body: {} })
    const { account } = await mail.admin.createAccount({ orgId: null }, { provider: 'mailgun', credentials: { apiKey: 'key-read', host: endpoint, webhookSigningKey: SIGNING_KEY } })
    const { domain } = await mail.admin.addDomain({ orgId: null }, { domain: 'in.example.org', sendAccountId: account.id, receiveAccountId: account.id, setupMode: 'manual' }, BASE)
    const urls = mail.webhookUrls(account, BASE)

    let webhooks: Record<string, { urls: string[] }> = { permanent_fail: { urls: ['https://app.test/api/inbox/webhooks/mailgun/events', 'https://other.test/hook'] } }
    let routes = [{ description: 'Old', expression: 'match_recipient(".*@in.example.org")', actions: ['forward("https://old.test/in")', 'stop()'], priority: 0 }]
    reply = (s) => {
      if (s.path === SIGNING_PATH) return { status: 401 }
      if (s.path === '/v4/domains/in.example.org') return { status: 200, body: { sending_dns_records: [{ record_type: 'TXT', name: 'in.example.org', value: 'v=spf1 include:mailgun.org ~all', valid: 'valid' }, { record_type: 'TXT', name: 'k1._domainkey.in.example.org', value: 'k=rsa', valid: 'unknown' }] } }
      if (s.path === '/v3/domains/in.example.org/webhooks') return { status: 200, body: { webhooks } }
      if (s.path.startsWith('/v3/routes')) return { status: 200, body: { items: routes } }
      return { status: 200, body: {} }
    }
    seen.length = 0
    const first = await mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    const send = first.roles.find(r => r.role === 'send')!.checks
    expect(send).toContainEqual(expect.objectContaining({ key: 'provider-domain', ok: true }))
    expect(send).toContainEqual(expect.objectContaining({ key: 'provider-dns', ok: null, detail: 'TXT k1._domainkey.in.example.org' }))
    expect(send).toContainEqual(expect.objectContaining({ key: 'webhooks', ok: false, detail: expect.stringContaining('Remove: https://app.test/api/inbox/webhooks/mailgun/events') }))
    expect(send).toContainEqual(expect.objectContaining({ key: 'webhooks', detail: expect.stringContaining('Not sent here yet: Permanent failure, Spam complaints, Unsubscribes.') }))
    expect(send).toContainEqual(expect.objectContaining({ key: 'credential:webhookSigningKey', ok: true }))
    const receive = first.roles.find(r => r.role === 'receive')!.checks
    expect(receive).toContainEqual(expect.objectContaining({ key: 'route', ok: false, detail: '"Old" takes this domain\'s mail first' }))
    // Only the key's test-mode send goes out: no receiving probe while the route is missing.
    const posts = seen.filter(x => x.method === 'POST' && x.path === '/v3/in.example.org/messages')
    expect(await Promise.all(posts.map(async x => (await fields(x))['o:testmode']))).toEqual(['yes'])
    expect((await domainRow(domain.id)).webhook_events).toBeNull()

    // Done by hand at Mailgun: our webhooks for every needed event and a route of our own.
    webhooks = Object.fromEntries(['permanent_fail', 'complained', 'unsubscribed'].map(kind => [kind, { urls: [urls.events, 'https://other.test/hook'] }]))
    // As Mailgun's form saves it, from the recipient *@in.example.org.
    routes = [{ description: 'Ours', expression: 'match_recipient("*@in.example.org")', actions: [`forward("${urls.inboundMime}")`, 'stop()'], priority: 0 }]
    const second = await mail.admin.checkDomain({ orgId: null }, domain.id, BASE)
    expect(second.roles.find(r => r.role === 'send')!.checks).toContainEqual(expect.objectContaining({ key: 'webhooks', ok: true }))
    expect(second.roles.find(r => r.role === 'receive')!.checks).toContainEqual(expect.objectContaining({ key: 'route', ok: true }))
    expect((await mail.admin.webhookStatus(await domainRow(domain.id))).state).toBe('connected')
    const steps = mail.admin.manualSteps(await accountRow(account.id), await domainRow(domain.id), 'receive', urls, [])
    expect(steps.map(s => s.check)).toEqual(['mx', 'route', 'probe'])
  })
})
