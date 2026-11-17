import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mapSendgridEvent, sendgridProvider, verifySendgridSignature } from '../adapters/sendgrid'
import { __setEndpointCheck } from '../adapters/http'
import type { MailAccountRow, ProviderMessage, WebhookRequest } from '../kernel/types'

interface Seen { method: string, path: string, headers: IncomingMessage['headers'], body: string }
type Reply = { status: number, body?: unknown, headers?: Record<string, string> }

const seen: Seen[] = []
let reply: (req: Seen) => Reply = () => ({ status: 200, body: {} })
let server: Server
let endpoint = ''

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      const r = reply(s)
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) })
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
})

beforeEach(() => {
  seen.length = 0
  reply = () => ({ status: 200, body: {} })
})

const creds = () => ({ apiKey: 'SG.test', endpoint })
const account = {} as MailAccountRow

function message(extra: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    from: { name: 'App', address: 'noreply@mail.example.org' },
    domain: 'mail.example.org',
    to: 'person@example.com',
    replyTo: null,
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    messageId: '<abc@mail.example.org>',
    headers: { 'Message-Id': '<abc@mail.example.org>' },
    attachments: [],
    correlation: { stream: 'account', orgId: 'org-1', ref: 'ref-1' },
    bypassProviderSuppression: false,
    signal: new AbortController().signal,
    ...extra
  }
}

describe('signed event webhook', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicB64 = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }).toString('base64')
  const body = Buffer.from(JSON.stringify([{ email: 'a@x.test', event: 'delivered', sg_message_id: 'abc.filter1.0', timestamp: 1, 'nx-ref': 'r1' }]))

  function signed(rawBody: Buffer, timestamp = String(Math.floor(Date.now() / 1000))) {
    const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('base64')
    return { 'X-Twilio-Email-Event-Webhook-Signature': signature, 'X-Twilio-Email-Event-Webhook-Timestamp': timestamp }
  }

  it('accepts a correctly signed payload', () => {
    expect(verifySendgridSignature(publicB64, signed(body), body)).toBeNull()
  })

  it('rejects a tampered body, a wrong key and a stale timestamp', () => {
    const headers = signed(body)
    expect(verifySendgridSignature(publicB64, headers, Buffer.from(body.toString().replace('a@x', 'b@x')))).toBe('Invalid signature')
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(verifySendgridSignature(other, headers, body)).toBe('Invalid signature')
    const old = String(Math.floor(Date.now() / 1000) - 20 * 60)
    expect(verifySendgridSignature(publicB64, signed(body, old), body)).toBe('Stale signature')
    expect(verifySendgridSignature(publicB64, {}, body)).toBe('Missing signature')
    expect(verifySendgridSignature(undefined, headers, body)).toMatch(/No webhook verification key/)
  })

  it('handleWebhook maps a signed batch and carries custom args as correlation', async () => {
    const raw = Buffer.from(JSON.stringify([
      { email: 'A@x.test', event: 'delivered', sg_message_id: 'msg1.filterdrecv-1.0', timestamp: 1700000000, 'nx-stream': 'account', 'nx-org': 'org-1', 'nx-ref': 'ref-1', 'nx-domain': 'Mail.Example.org' },
      { email: 'b@x.test', event: 'processed' }
    ]))
    const req: WebhookRequest = { kind: 'events', headers: signed(raw), rawBody: raw, account }
    const res = await sendgridProvider.handleWebhook({ webhookPublicKey: publicB64 }, req)
    expect(res).toMatchObject({
      type: 'events',
      events: [{ type: 'delivered', recipient: 'a@x.test', providerMessageId: 'msg1', stream: 'account', orgId: 'org-1', ref: 'ref-1', domain: 'mail.example.org' }]
    })
    if (res.type === 'events') expect(res.events).toHaveLength(1)

    const forged = await sendgridProvider.handleWebhook({ webhookPublicKey: publicB64 }, { ...req, rawBody: Buffer.from('[]') })
    expect(forged).toEqual({ type: 'rejected', reason: 'Invalid signature' })
  })
})

describe('event mapping', () => {
  const map = (e: Record<string, unknown>) => mapSendgridEvent({ email: 'a@x.test', timestamp: 1700000000, ...e })

  it('bounce is a permanent bounce, blocked is a deferral', () => {
    expect(map({ event: 'bounce', type: 'bounce', reason: '550 no such user' })).toMatchObject({ type: 'bounced', permanent: true, detail: '550 no such user' })
    expect(map({ event: 'bounce', type: 'blocked' })).toMatchObject({ type: 'deferred', permanent: false })
    expect(map({ event: 'deferred' })).toMatchObject({ type: 'deferred' })
  })

  it('list drops become dropped with their list; other drops are rejections', () => {
    expect(map({ event: 'dropped', reason: 'Bounced Address' })).toMatchObject({ type: 'dropped', list: 'bounce' })
    expect(map({ event: 'dropped', reason: 'Spam Reporting Address' })).toMatchObject({ type: 'dropped', list: 'complaint' })
    expect(map({ event: 'dropped', reason: 'Unsubscribed Address' })).toMatchObject({ type: 'dropped', list: 'unsubscribe' })
    expect(map({ event: 'dropped', reason: 'Group Unsubscribe' })).toMatchObject({ type: 'dropped', list: 'unsubscribe' })
    expect(map({ event: 'dropped', reason: 'Invalid' })).toMatchObject({ type: 'rejected', permanent: true })
    expect(map({ event: 'dropped', reason: 'Expired' })).toMatchObject({ type: 'rejected', permanent: false })
    expect(map({ event: 'dropped', reason: 'Invalid' })?.list).toBeUndefined()
  })

  it('spamreport, unsubscribe, group_unsubscribe, delivered, open, click', () => {
    expect(map({ event: 'spamreport' })?.type).toBe('complained')
    expect(map({ event: 'unsubscribe' })?.type).toBe('unsubscribed')
    expect(map({ event: 'group_unsubscribe' })?.type).toBe('unsubscribed')
    expect(map({ event: 'delivered' })).toMatchObject({ type: 'delivered', occurredAt: new Date(1700000000 * 1000) })
    expect(map({ event: 'open' })?.type).toBe('opened')
    expect(map({ event: 'click' })?.type).toBe('clicked')
    expect(map({ event: 'processed' })).toBeNull()
  })
})

describe('send', () => {
  beforeEach(() => {
    reply = () => ({ status: 202, headers: { 'X-Message-Id': 'sg-id-1' } })
  })

  it('posts v3 mail send with custom args and headers and returns both ids', async () => {
    const res = await sendgridProvider.send(creds(), message({
      replyTo: 'reply@example.org',
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') },
        { filename: 'logo.png', contentType: 'image/png', data: Buffer.from('png'), cid: 'logo' }
      ]
    }))
    expect(res).toEqual({ status: 'sent', providerMessageId: 'sg-id-1', messageId: '<abc@mail.example.org>' })
    const [req] = seen
    expect(req).toMatchObject({ method: 'POST', path: '/v3/mail/send' })
    expect(req!.headers.authorization).toBe('Bearer SG.test')
    const body = JSON.parse(req!.body)
    expect(body.personalizations).toEqual([{ to: [{ email: 'person@example.com' }] }])
    expect(body.from).toEqual({ email: 'noreply@mail.example.org', name: 'App' })
    expect(body.reply_to).toEqual({ email: 'reply@example.org' })
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Hi' }, { type: 'text/html', value: '<p>Hi</p>' }])
    expect(body.headers).toEqual({ 'Message-Id': '<abc@mail.example.org>' })
    expect(body.custom_args).toEqual({ 'nx-stream': 'account', 'nx-domain': 'mail.example.org', 'nx-org': 'org-1', 'nx-ref': 'ref-1' })
    expect(body.attachments).toEqual([
      { content: Buffer.from('hello').toString('base64'), filename: 'a.txt', type: 'text/plain', disposition: 'attachment' },
      { content: Buffer.from('png').toString('base64'), filename: 'logo.png', type: 'image/png', disposition: 'inline', content_id: 'logo' }
    ])
  })

  it('sets no bypass flag on an ordinary send', async () => {
    await sendgridProvider.send(creds(), message())
    const body = JSON.parse(seen[0]!.body)
    expect(body.mail_settings).toBeUndefined()
    expect(seen[0]!.body).not.toContain('bypass')
  })

  it('sets only bypass_bounce_management when bypassProviderSuppression is true', async () => {
    await sendgridProvider.send(creds(), message({ bypassProviderSuppression: true }))
    const body = JSON.parse(seen[0]!.body)
    expect(body.mail_settings).toEqual({ bypass_bounce_management: { enable: true } })
    expect(seen[0]!.body).not.toContain('bypass_list_management')
  })

  it('maps failures: 401 rejects the key, 429/5xx retry, other 4xx do not', async () => {
    reply = () => ({ status: 401, body: { errors: [] } })
    expect(await sendgridProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: false, keyRejected: true })
    reply = () => ({ status: 429 })
    expect(await sendgridProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: true })
    reply = () => ({ status: 503 })
    expect(await sendgridProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: true })
    reply = () => ({ status: 400, body: { errors: [{ message: 'bad' }] } })
    expect(await sendgridProvider.send(creds(), message())).toMatchObject({ status: 'failed', retryable: false })
  })
})

describe('verifyCredentials', () => {
  it('maps scopes to capabilities and sends no mail', async () => {
    reply = () => ({ status: 200, body: { scopes: ['mail.send', 'whitelabel.create', 'whitelabel.read', 'whitelabel.update', 'user.webhooks.event.settings.read', 'user.webhooks.event.settings.update'] } })
    const res = await sendgridProvider.verifyCredentials(creds(), 'mail.example.org')
    expect(res).toEqual({ ok: true, capabilities: { send: true, domains: true, routes: false, webhooks: true, suppressionLists: false } })
    expect(seen.map(s => `${s.method} ${s.path}`)).toEqual(['GET /v3/scopes'])
  })

  it('a key without the suppression scopes gives unmanaged; with them, mirrored', async () => {
    reply = () => ({ status: 200, body: { scopes: ['mail.send'] } })
    const res = await sendgridProvider.verifyCredentials(creds())
    if (!res.ok) throw new Error('expected ok')
    expect(sendgridProvider.providerSuppression.mode(res.capabilities)).toBe('unmanaged')

    reply = () => ({ status: 200, body: { scopes: ['mail.send', 'suppression.bounces.delete', 'suppression.spam_reports.delete', 'asm.suppressions.global.delete'] } })
    const noGroups = await sendgridProvider.verifyCredentials(creds())
    if (!noGroups.ok) throw new Error('expected ok')
    expect(sendgridProvider.providerSuppression.mode(noGroups.capabilities)).toBe('unmanaged')

    reply = () => ({ status: 200, body: { scopes: ['mail.send', 'suppression.bounces.delete', 'suppression.spam_reports.delete', 'asm.suppressions.global.delete', 'asm.groups.suppressions.read', 'asm.groups.suppressions.delete'] } })
    const full = await sendgridProvider.verifyCredentials(creds())
    if (!full.ok) throw new Error('expected ok')
    expect(sendgridProvider.providerSuppression.mode(full.capabilities)).toBe('mirrored')
  })

  it('a rejected key fails', async () => {
    reply = () => ({ status: 401 })
    expect(await sendgridProvider.verifyCredentials(creds())).toEqual({ ok: false, error: 'SendGrid rejected the key' })
  })

  it('accepts only an https endpoint on SendGrid\'s own API hosts', async () => {
    __setEndpointCheck(null)
    try {
      for (const bad of ['http://api.sendgrid.com', 'https://169.254.169.254', 'https://api.sendgrid.com.evil.com', 'https://evil.example.com/v3']) {
        expect(await sendgridProvider.verifyCredentials({ apiKey: 'SG.test', endpoint: bad })).toMatchObject({ ok: false, error: expect.stringContaining('https URL') })
        expect(await sendgridProvider.send({ apiKey: 'SG.test', endpoint: bad }, message())).toMatchObject({ status: 'failed', retryable: false })
      }
      expect(seen).toHaveLength(0)
    } finally {
      __setEndpointCheck(url => url.hostname === '127.0.0.1')
    }
  })
})

describe('provider suppression release', () => {
  it('deletes from the list that matches, and tolerates 404', async () => {
    reply = s => ({ status: s.path.includes('spam_reports') ? 404 : 204 })
    const release = sendgridProvider.providerSuppression.release!
    await release(creds(), 'mail.example.org', 'a+b@x.test', 'bounce')
    await release(creds(), 'mail.example.org', 'a+b@x.test', 'complaint')
    await release(creds(), 'mail.example.org', 'a+b@x.test', 'unsubscribe')
    expect(seen.map(s => `${s.method} ${s.path}`)).toEqual([
      'DELETE /v3/suppression/bounces/a%2Bb%40x.test',
      'DELETE /v3/suppression/spam_reports/a%2Bb%40x.test',
      'DELETE /v3/asm/suppressions/global/a%2Bb%40x.test',
      'GET /v3/asm/suppressions/a%2Bb%40x.test'
    ])
  })

  it('an unsubscribe release also removes the address from each group it unsubscribed from', async () => {
    reply = s => s.method === 'GET'
      ? { status: 200, body: { suppressions: [{ id: 4, name: 'News', suppressed: true }, { id: 7, name: 'Other', suppressed: false }, { id: 9, name: 'Digest', suppressed: true }] } }
      : { status: 204 }
    await sendgridProvider.providerSuppression.release!(creds(), 'mail.example.org', 'u@x.test', 'unsubscribe')
    expect(seen.map(s => `${s.method} ${s.path}`)).toEqual([
      'DELETE /v3/asm/suppressions/global/u%40x.test',
      'GET /v3/asm/suppressions/u%40x.test',
      'DELETE /v3/asm/groups/4/suppressions/u%40x.test',
      'DELETE /v3/asm/groups/9/suppressions/u%40x.test'
    ])
    reply = s => s.method === 'GET' ? { status: 403 } : { status: 204 }
    await expect(sendgridProvider.providerSuppression.release!(creds(), 'mail.example.org', 'u@x.test', 'unsubscribe')).rejects.toMatchObject({ capability: 'suppressionLists' })
  })
})

describe('webhook configuration', () => {
  it('turns on the event webhook with only the required events, then signing', async () => {
    reply = s => ({ status: 200, body: s.path.endsWith('/signed') ? { public_key: 'PK' } : {} })
    const urls = { events: 'https://app.test/api/mail/webhooks/t/events', inbound: 'https://app.test/i', inboundMime: 'https://app.test/i/mime' }
    await sendgridProvider.configureWebhooks!(creds(), 'mail.example.org', urls, { delivered: false, events: ['bounced', 'complained', 'unsubscribed', 'rejected', 'dropped'] })
    expect(seen.map(s => `${s.method} ${s.path}`)).toEqual(['PATCH /v3/user/webhooks/event/settings', 'PATCH /v3/user/webhooks/event/settings/signed'])
    const body = JSON.parse(seen[0]!.body)
    expect(body).toMatchObject({ enabled: true, url: urls.events, bounce: true, dropped: true, spam_report: true, unsubscribe: true, group_unsubscribe: true, delivered: false, open: false, click: false, processed: false })
  })
})

describe('Inbound Parse (raw mode)', () => {
  it('parses the raw MIME with the envelope recipients and spam score', async () => {
    const mime = [
      'From: Sender <sender@outside.test>',
      'To: hello@mail.example.org',
      'Subject: Raw hello',
      'Message-ID: <raw-1@outside.test>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body text'
    ].join('\r\n')
    const form = new FormData()
    form.append('email', mime)
    form.append('envelope', JSON.stringify({ to: ['hello@mail.example.org'], from: 'bounce@outside.test' }))
    form.append('spam_score', '1.5')
    const encoded = new Response(form)
    const rawBody = Buffer.from(await encoded.arrayBuffer())
    const res = await sendgridProvider.handleWebhook({}, { kind: 'inbound', headers: { 'Content-Type': encoded.headers.get('content-type')! }, rawBody, account })
    if (res.type !== 'inbound') throw new Error(`expected inbound, got ${res.type}`)
    expect(res.mail).toMatchObject({
      envelopeTo: ['hello@mail.example.org'],
      envelopeFrom: 'bounce@outside.test',
      messageId: '<raw-1@outside.test>',
      subject: 'Raw hello',
      spamScore: 1.5
    })
    expect(res.mail.text?.trim()).toBe('Body text')
  })

  it('rejects a post without the raw message', async () => {
    const form = new FormData()
    form.append('text', 'parsed mode')
    const encoded = new Response(form)
    const res = await sendgridProvider.handleWebhook({}, { kind: 'inbound', headers: { 'content-type': encoded.headers.get('content-type')! }, rawBody: Buffer.from(await encoded.arrayBuffer()), account })
    expect(res.type).toBe('rejected')
  })
})
