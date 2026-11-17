import type { Capabilities, CapabilityKey, DnsRecord, MailAccountRow, MailDomainRow, SuppressionReason, SuppressionScope } from './schema'

export type { Capabilities, CapabilityKey, DnsRecord, MailAccountRow, MailDomainRow }

export interface MailStream {
  id: string
  label: string
  // From local part, e.g. 'noreply'
  defaultLocal: string
  // Follows the org's own domain when the org has one
  orgAssignable: boolean
  // Replies come back to this stream's domain: only domains that can receive qualify
  needsReceive?: boolean
  // Mail the person just asked for: skips kernel suppressions and gets past the provider's list where it can
  userInitiated?: boolean
  // High volume: the admin UI warns when it shares a domain that posts delivered events
  bulk?: boolean
  // send() goes through the outbox with an immediate first attempt
  queued?: boolean
  // Outbox rows older than this fail as `expired`; default 1440
  maxAgeMinutes?: number
}

export interface MailAttachment {
  filename: string
  contentType: string
  data: Buffer
  cid?: string
}

export interface OutgoingMail {
  stream: string
  orgId?: string | null
  fromName?: string
  fromLocal?: string
  to: string
  replyTo?: string
  subject: string
  html: string
  text?: string
  inReplyTo?: string
  references?: string
  headers?: Record<string, string>
  unsubscribeUrl?: string
  autoReply?: boolean
  attachments?: MailAttachment[]
  ref?: string
  expiresInMinutes?: number
}

export type SendResult =
  | { status: 'sent', accountId: string, domain: string, providerMessageId: string | null, messageId: string | null }
  | { status: 'suppressed', reason: SuppressionReason }
  | { status: 'refused', guard: string, reason: string }
  | { status: 'no_sender', stream: string }
  | { status: 'failed', retryable: boolean, error: string }
  | { status: 'unknown', error: string }
  | { status: 'queued', outboxId: string }

export interface SendGuardContext {
  stream: MailStream
  domain: string
  accountId: string
  accountOrgId: string | null
}

export type SendGuardResult = { ok: true } | { ok: false, reason: string }

export interface SendGuard {
  id: string
  check: (m: OutgoingMail, ctx: SendGuardContext) => Promise<SendGuardResult>
}

export interface Correlation {
  stream: string
  orgId: string | null
  ref: string | null
}

// What an adapter is handed: everything resolved, nothing left to decide.
export interface ProviderMessage {
  from: { name: string | null, address: string }
  // The provider's sending domain (may differ from the From domain)
  domain: string
  to: string
  replyTo: string | null
  subject: string
  html: string
  text: string
  // The Message-Id the kernel set, with angle brackets
  messageId: string
  // Every header beyond From/To/Subject/Reply-To, including Message-Id
  headers: Record<string, string>
  attachments: MailAttachment[]
  correlation: Correlation
  bypassProviderSuppression: boolean
  // Aborted when the kernel's request timeout elapses
  signal: AbortSignal
}

export type ProviderSendResult =
  | { status: 'sent', providerMessageId: string | null, messageId: string | null }
  | { status: 'failed', retryable: boolean, error: string, keyRejected?: boolean }
  | { status: 'unknown', error: string }

export interface CredentialField {
  key: string
  label: string
  secret: boolean
  optional?: boolean
  env?: string
  help?: string
}

export type Credentials = Record<string, string>

export interface ManualStep {
  title: string
  detail?: string
  // Values to copy, e.g. a URL or a DNS record
  values?: { label: string, value: string }[]
}

export interface WebhookUrls {
  events: string
  inbound: string
  inboundMime: string
}

export type MailEventType = 'delivered' | 'bounced' | 'deferred' | 'complained' | 'unsubscribed' | 'rejected' | 'dropped' | 'opened' | 'clicked'

export interface MailEvent {
  type: MailEventType
  permanent: boolean
  list?: 'bounce' | 'complaint' | 'unsubscribe'
  recipient: string
  providerMessageId: string | null
  occurredAt: Date
  detail: string | null
  stream: string | null
  orgId: string | null
  ref: string | null
  // The provider's sending domain, when the event names it
  domain?: string | null
}

export interface InboundAttachment {
  filename: string
  contentType: string
  data: Buffer
  cid: string | null
  inline: boolean
}

export interface InboundHeaders {
  get: (name: string) => string | null
  getAll: (name: string) => string[]
}

export interface InboundMail {
  raw: Buffer
  envelopeTo: string[]
  envelopeFrom: string | null
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  from: { address: string, name: string | null } | null
  to: string[]
  cc: string[]
  subject: string
  text: string | null
  html: string | null
  headers: InboundHeaders
  attachments: InboundAttachment[]
  authentication: { dmarc: 'pass' | 'fail' | 'none', dkim: { domain: string, result: string }[], spf: string }
  // Provider-reported spam score, when the provider adds one
  spamScore?: number | null
}

export interface WebhookRequest {
  kind: 'events' | 'inbound'
  headers: Record<string, string | undefined>
  rawBody: Buffer
  account: MailAccountRow
  // Path segments after /inbound or /events (e.g. 'mime')
  variant?: string | null
}

export type WebhookResult =
  | { type: 'handshake', response?: unknown }
  | { type: 'events', events: MailEvent[] }
  | { type: 'inbound', mail: InboundMail }
  | { type: 'rejected', reason: string }

export type ProviderSuppressionMode = 'disabled' | 'mirrored' | 'unmanaged'
export type ProviderList = 'bounce' | 'complaint' | 'unsubscribe'

export interface VerifyResult {
  ok: true
  capabilities: Capabilities
}

export interface ProvisionResult {
  records: DnsRecord[]
  // Capabilities the provisioning proved or disproved along the way
  capabilities?: Capabilities
  refs?: Record<string, unknown>
  dkimSelector?: string
}

export interface CheckResult {
  status: 'pending' | 'verified' | 'failed'
  records: DnsRecord[]
  error?: string
}

// A provider call refused for lack of permission. Adapters throw it from
// provisionDomain/checkDomain/configureWebhooks so the kernel records the
// capability as false and falls back to the manual path.
export class ProviderPermissionError extends Error {
  constructor(public readonly capability: CapabilityKey, message?: string) {
    super(message ?? `The key isn't allowed to manage ${capability}`)
  }
}

export interface MailProvider {
  id: string
  label: string
  credentialFields: CredentialField[]
  domainCredentialFields?: Omit<CredentialField, 'env'>[]
  supports: { send: boolean, receive: boolean, events: boolean }
  webhookScope: 'domain' | 'account'
  // Caveats per role, shown where an admin picks the provider or sets up a domain on it
  notes?: { send?: string, receive?: string }

  // Capabilities that hold per domain rather than per key (SES's configuration
  // set): stored on the domain row even when the domain has no key of its own.
  domainCapabilities?: CapabilityKey[]
  // Whether an MX host is one of the provider's inbound mail servers.
  receivesAt?: (exchange: string) => boolean

  // `retryable` marks a failure that says nothing about the key (5xx, 429).
  verifyCredentials: (creds: Credentials, domain?: string, opts?: { probeAddress?: string }) => Promise<VerifyResult | { ok: false, error: string, retryable?: boolean }>
  manualSetup: (domain: string, role: 'send' | 'receive', urls: WebhookUrls, opts: { events: MailEventType[] }) => ManualStep[]

  send: (creds: Credentials, msg: ProviderMessage) => Promise<ProviderSendResult>
  provisionDomain?: (creds: Credentials, domain: string, role: 'send' | 'receive', urls: WebhookUrls) => Promise<ProvisionResult>
  checkDomain?: (creds: Credentials, domain: string, role: 'send' | 'receive', refs: Record<string, unknown>) => Promise<CheckResult>
  // May return credentials the provider issued (e.g. a webhook verification
  // key); the kernel stores them on the account.
  configureWebhooks?: (creds: Credentials, domain: string, urls: WebhookUrls, opts: { delivered: boolean, events: MailEventType[] }) => Promise<void | { credentials?: Credentials }>
  deprovisionDomain?: (creds: Credentials, domain: string, refs: Record<string, unknown>) => Promise<void>

  providerSuppression: {
    mode: (capabilities: Capabilities) => ProviderSuppressionMode
    release?: (creds: Credentials, domain: string, address: string, list: ProviderList) => Promise<void>
  }

  handleWebhook: (creds: Credentials, req: WebhookRequest) => Promise<WebhookResult>
}

export interface ParsedAddress {
  address: string
  local: string
  domain: string
}

export interface InboundContext {
  recipient: ParsedAddress
  domain: MailDomainRow
  account: MailAccountRow
  mail: InboundMail
}

export type InboundOutcome = 'handled' | 'drop' | 'retry'

export interface InboundHandler {
  id: string
  // Ascending; the kernel's probe handler is 0, the inbox catch-all 1000
  order: number
  match: (ctx: InboundContext) => boolean | Promise<boolean>
  handle: (mail: InboundMail, ctx: InboundContext) => Promise<InboundOutcome>
}

export interface MailEventHandler {
  id: string
  stream?: string
  types?: MailEventType[]
  handle: (event: MailEvent, ctx: { account: MailAccountRow }) => Promise<void>
}

export interface SuppressionHit {
  reason: SuppressionReason
  scope: SuppressionScope
}

export type MailTransport = 'provider' | 'log' | { smtp: { host: string, port: number } }
