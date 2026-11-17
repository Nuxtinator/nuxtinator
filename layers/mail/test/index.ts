// A fake mail provider for tests. It delivers to a local SMTP catcher
// (Mailpit) unless told not to, accepts raw-MIME inbound and HMAC-signed JSON
// events, and its capabilities, suppression mode and send outcomes are all
// adjustable through `control`.
import { createHmac } from 'node:crypto'
import { constantTimeEqual } from '../kernel/crypto'
import { parseInbound } from '../kernel/inbound-parse'
import { sendViaSmtp } from '../kernel/mime'
import {
  ProviderPermissionError, type Capabilities, type CheckResult, type Credentials, type MailEvent, type MailProvider,
  type ProviderList, type ProviderMessage, type ProviderSendResult, type ProviderSuppressionMode
} from '../kernel/types'

export interface FakeControl {
  capabilities: Capabilities
  mode: ProviderSuppressionMode | null
  // Consumed one per send before falling back to delivering
  nextResults: ProviderSendResult[]
  // Milliseconds to wait before each send answers (honours the abort signal)
  hangMs: number
  // Sends to these recipients hang until aborted
  hangFor: Set<string>
  domainStatus: CheckResult['status']
  deliver: boolean
  smtp: { host: string, port: number }
}

export interface FakeProvider extends MailProvider {
  control: FakeControl
  sent: ProviderMessage[]
  released: { domain: string, address: string, list: ProviderList }[]
  provisioned: { domain: string, role: 'send' | 'receive' }[]
  webhooksConfigured: { domain: string, events: string[] }[]
  verifyCalls: { domain?: string }[]
  reset: () => void
}

export function fakeSignature(signingKey: string, body: Buffer | string): string {
  return createHmac('sha256', signingKey).update(body).digest('hex')
}

function defaults(): FakeControl {
  return {
    capabilities: { send: true, domains: true, routes: true, webhooks: true, suppressionLists: true },
    mode: null,
    nextResults: [],
    hangMs: 0,
    hangFor: new Set(),
    domainStatus: 'verified',
    deliver: true,
    smtp: { host: process.env.SMTP_HOST || 'localhost', port: Number.parseInt(process.env.SMTP_PORT || '1025', 10) }
  }
}

function hasKey(creds: Credentials): boolean {
  return !!(creds.apiKey || creds.sendingKey)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

export function createFakeProvider(id = 'fake'): FakeProvider {
  const fake: FakeProvider = {
    id,
    label: 'Fake provider',
    credentialFields: [
      { key: 'apiKey', label: 'API key', secret: true, optional: true, env: 'MAIL_FAKE_API_KEY' },
      { key: 'signingKey', label: 'Webhook signing key', secret: true, optional: true, env: 'MAIL_FAKE_SIGNING_KEY' }
    ],
    domainCredentialFields: [
      { key: 'sendingKey', label: 'Domain sending key', secret: true, optional: true }
    ],
    supports: { send: true, receive: true, events: true },
    webhookScope: 'domain',
    control: defaults(),
    sent: [],
    released: [],
    provisioned: [],
    webhooksConfigured: [],
    verifyCalls: [],
    reset() {
      fake.control = defaults()
      fake.sent.length = 0
      fake.released.length = 0
      fake.provisioned.length = 0
      fake.webhooksConfigured.length = 0
      fake.verifyCalls.length = 0
    },

    async verifyCredentials(creds, domain) {
      fake.verifyCalls.push({ domain })
      if (creds.apiKey === 'invalid') return { ok: false, error: 'Unauthorized' }
      const caps: Capabilities = {}
      const c = fake.control.capabilities
      if (creds.sendingKey && !creds.apiKey) {
        // A domain sending key can only send.
        if (domain) caps.send = true
        caps.suppressionLists = false
        return { ok: true, capabilities: caps }
      }
      if (domain) caps.send = c.send !== false && hasKey(creds)
      if (domain && c.suppressionLists !== undefined) caps.suppressionLists = c.suppressionLists
      return { ok: true, capabilities: caps }
    },

    manualSetup(domain, role, urls, opts) {
      if (role === 'send') {
        return [
          { title: `Add ${domain} at the fake provider` },
          { title: 'Subscribe the events webhook', detail: `Events: ${opts.events.join(', ')}`, values: [{ label: 'Events URL', value: urls.events }] }
        ]
      }
      return [{ title: 'Forward inbound mail as raw MIME', values: [{ label: 'Inbound URL', value: urls.inboundMime }] }]
    },

    async send(creds, msg) {
      if (!hasKey(creds) || creds.apiKey === 'reject') {
        return { status: 'failed', retryable: false, error: 'Unauthorized (401)', keyRejected: true }
      }
      if (fake.control.hangFor.has(msg.to)) {
        await wait(24 * 3600_000, msg.signal)
      }
      if (fake.control.hangMs) await wait(fake.control.hangMs, msg.signal)
      const next = fake.control.nextResults.shift()
      if (next) {
        if (next.status === 'sent') fake.sent.push(msg)
        return next
      }
      fake.sent.push(msg)
      if (fake.control.deliver) {
        const res = await sendViaSmtp(fake.control.smtp.host, fake.control.smtp.port, msg)
        if (res.status !== 'sent') return res
      }
      return { status: 'sent', providerMessageId: `fake-${fake.sent.length}-${Date.now()}`, messageId: msg.messageId }
    },

    async provisionDomain(_creds, domain, role) {
      if (fake.control.capabilities.domains === false) throw new ProviderPermissionError('domains')
      fake.provisioned.push({ domain, role })
      const records = role === 'send'
        ? [
            { role: 'send' as const, type: 'TXT' as const, name: domain, value: 'v=spf1 include:fake.example ~all', status: 'pending' as const },
            { role: 'send' as const, type: 'TXT' as const, name: `fk._domainkey.${domain}`, value: 'k=rsa; p=FAKE', status: 'pending' as const }
          ]
        : [{ role: 'receive' as const, type: 'MX' as const, name: domain, value: 'mx.fake.example', priority: 10, status: 'pending' as const }]
      return { records, refs: { id: `fake-${domain}` }, dkimSelector: role === 'send' ? 'fk' : undefined }
    },

    async checkDomain(_creds, domain, role) {
      const status = fake.control.domainStatus
      const records = role === 'send'
        ? [{ role: 'send' as const, type: 'TXT' as const, name: domain, value: 'v=spf1 include:fake.example ~all', status }]
        : [{ role: 'receive' as const, type: 'MX' as const, name: domain, value: 'mx.fake.example', priority: 10, status }]
      return { status, records }
    },

    async configureWebhooks(_creds, domain, _urls, opts) {
      if (fake.control.capabilities.webhooks === false) throw new ProviderPermissionError('webhooks')
      fake.webhooksConfigured.push({ domain, events: opts.events })
    },

    async deprovisionDomain() {},

    providerSuppression: {
      mode: caps => fake.control.mode ?? (caps.suppressionLists ? 'mirrored' : 'unmanaged'),
      async release(_creds, domain, address, list) {
        fake.released.push({ domain, address, list })
      }
    },

    async handleWebhook(creds, req) {
      const signature = req.headers['x-fake-signature'] ?? ''
      if (!creds.signingKey || !signature || !constantTimeEqual(fakeSignature(creds.signingKey, req.rawBody), signature)) {
        return { type: 'rejected', reason: 'Invalid signature' }
      }
      if (req.kind === 'inbound') {
        const to = (req.headers['x-fake-envelope-to'] ?? '').split(',').map(s => s.trim()).filter(Boolean)
        return { type: 'inbound', mail: await parseInbound(req.rawBody, { to, from: req.headers['x-fake-envelope-from'] ?? null }) }
      }
      const body = JSON.parse(req.rawBody.toString('utf8')) as { events?: (Partial<Omit<MailEvent, 'occurredAt'>> & Pick<MailEvent, 'type' | 'recipient'> & { occurredAt: string })[], handshake?: boolean }
      if (body.handshake) return { type: 'handshake', response: { confirmed: true } }
      return {
        type: 'events',
        events: (body.events ?? []).map(e => ({
          permanent: false,
          providerMessageId: null,
          detail: null,
          stream: null,
          orgId: null,
          ref: null,
          ...e,
          occurredAt: new Date(e.occurredAt)
        }))
      }
    }
  }
  return fake
}
