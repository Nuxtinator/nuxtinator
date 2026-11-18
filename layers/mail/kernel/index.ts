// @nuxtinator/mail/kernel — the provider-neutral mail kernel. Framework-free:
// it takes a Kysely instance and plain objects, so Nuxt apps and plain worker
// processes on the same database use it the same way.
import type { Kysely, Transaction } from 'kysely'
import * as admin from './admin'
import { addressHash } from './address'
import type { Kernel } from './context'
import { deriveKey, outboxKeyPair } from './crypto'
import { systemDns, type DnsLookup } from './dns'
import { envFingerprint, readEnvAccount, readTransport, type MailEnv } from './env'
import { envAccountStatus, syncEnvAccount } from './env-account'
import { handleEvents } from './events'
import { dispatchInbound, probeHandler } from './inbound'
import { enqueue, flush, purgeOutbox, runOutboxSweep, sendQueued, stopOutbox, OUTBOX_CHANNEL } from './outbox'
import { fromDomainOf, resolveSenderRow } from './resolve'
import { sendNow } from './send'
import { isSuppressed, suppressedAmong } from './suppressions'
import { handleWebhook, webhookToken, webhookUrls, type WebhookInput } from './webhooks'
import type { MailAccountRow, MailDatabase } from './schema'
import type {
  InboundHandler, InboundMail, MailEvent, MailEventHandler, MailProvider, MailStream, MailTransport, OutgoingMail,
  SendGuard, SendResult, SuppressionHit
} from './types'

export * from './types'
export * from './schema'
export { addressHash, notSuppressed, parseAddress, domainOf } from './address'
export { encryptSecret, decryptSecret, encryptJson, decryptJson, seal, unseal, outboxKeyPair, hmacHex, constantTimeEqual } from './crypto'
export { parseInbound, parseAuthenticationResults, isAuthenticated } from './inbound-parse'
export { buildMime, htmlToText } from './mime'
export { memoryDns, systemDns, type DnsLookup } from './dns'
export { MailAdminError, ownershipRecord, probeAddress, type MailAlert, type AccountView, type DomainCheck, type StreamOverview, type SuppressionView } from './admin'
export { PROBE_STREAM } from './events'
export { effectiveCapabilities } from './context'
export { PROBE_PREFIX } from './inbound'
export { OUTBOX_CHANNEL } from './outbox'
export type { MailEnv } from './env'

const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/
const LEASE_MARGIN_SECONDS = 5

export interface CreateMailOptions {
  db: Kysely<any>
  providers: MailProvider[]
  streams: MailStream[]
  env: MailEnv
  secretKey?: string
  outboxPublicKey?: string
  webhookSecret?: string
  guards?: SendGuard[]
  inboundHandlers?: InboundHandler[]
  eventHandlers?: MailEventHandler[]
  transport?: MailTransport
  subscribe?: (channel: string, onNotify: () => void) => void
  // Outbox sweep tick once startSweeping() runs, in seconds (default 30,
  // minimum 5).
  sweepSeconds?: number
  // Provider request timeout; capped at 60 seconds.
  requestTimeoutMs?: number
  // How long an outbox claim holds its rows before another process may take
  // them (default 120). Never shorter than the request timeout plus a margin.
  leaseSeconds?: number
  dns?: DnsLookup
  log?: (line: string) => void
}

function uniqueIds<T extends { id: string }>(items: T[], what: string): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`Two mail ${what}s share the id "${item.id}"`)
    map.set(item.id, item)
  }
  return map
}

export function createMail(opts: CreateMailOptions) {
  const providers = uniqueIds(opts.providers, 'provider')
  const streams = uniqueIds(opts.streams, 'stream')
  for (const id of streams.keys()) {
    if (!STREAM_ID.test(id)) throw new Error(`Mail stream id "${id}" may only hold letters, digits, - and _`)
  }

  const envAccount = readEnvAccount(opts.env, providers)
  const secretKey = opts.secretKey || null
  const outboxKeys = secretKey ? outboxKeyPair(secretKey) : null
  const outboxPublicKey = outboxKeys?.publicKey ?? opts.outboxPublicKey
  if (!outboxPublicKey) throw new Error('createMail needs a secretKey or an outboxPublicKey')
  const webhookSecret = opts.webhookSecret
    ? Buffer.from(opts.webhookSecret, 'utf8')
    : secretKey ? deriveKey(secretKey, 'webhook') : null

  const requestTimeoutMs = Math.min(opts.requestTimeoutMs ?? 30_000, 60_000)
  const k: Kernel = {
    db: opts.db as Kysely<MailDatabase>,
    providers,
    streams,
    env: opts.env,
    envAccount,
    envFingerprint: envAccount && secretKey ? envFingerprint(deriveKey(secretKey, 'env-fingerprint'), envAccount) : null,
    secretKey,
    outboxKeys,
    outboxPublicKey,
    webhookSecret,
    guards: [...(opts.guards ?? [])],
    inboundHandlers: [],
    eventHandlers: [...(opts.eventHandlers ?? [])],
    transport: opts.transport ?? readTransport(opts.env),
    requestTimeoutMs,
    leaseSeconds: Math.max(opts.leaseSeconds ?? 120, requestTimeoutMs / 1000 + LEASE_MARGIN_SECONDS),
    dns: opts.dns ?? systemDns,
    log: opts.log ?? (line => console.log(line)),
    envCheck: null,
    claims: new Set(),
    stopped: false
  }
  k.inboundHandlers = [probeHandler(k), ...(opts.inboundHandlers ?? [])]

  const canSend = () => {
    if (!k.secretKey) throw new Error('This mail instance has no secret key, so it can only enqueue')
  }

  let timer: ReturnType<typeof setInterval> | null = null
  const sweepSeconds = Number.isFinite(opts.sweepSeconds) ? Math.max(5, opts.sweepSeconds!) : 30
  const startSweeping = () => {
    if (!k.secretKey || timer) return
    const sweep = () => {
      if (k.stopped) return
      runOutboxSweep(k).catch(err => k.log(`[mail] outbox sweep failed: ${err instanceof Error ? err.message : err}`))
    }
    timer = setInterval(sweep, sweepSeconds * 1000)
    timer.unref?.()
    opts.subscribe?.(OUTBOX_CHANNEL, sweep)
  }

  const mail = {
    get streams() {
      return [...streams.values()]
    },
    get providers() {
      return [...providers.values()]
    },
    get transport() {
      return k.transport
    },
    outboxPublicKey: k.outboxPublicKey,
    canSend: !!k.secretKey,

    async send(m: OutgoingMail): Promise<SendResult> {
      canSend()
      const stream = streams.get(m.stream)
      if (stream?.queued) return await sendQueued(k, m)
      return await sendNow(k, m)
    },
    async enqueue(m: OutgoingMail, { tx }: { tx: Transaction<any> }) {
      return await enqueue(k, m, tx)
    },
    async flush(outboxIds: string[]) {
      canSend()
      await flush(k, outboxIds)
    },
    async runOutboxSweep() {
      canSend()
      await runOutboxSweep(k)
    },
    async purgeOutbox() {
      return await purgeOutbox(k)
    },
    startSweeping,
    async syncEnvAccount() {
      await syncEnvAccount(k)
    },
    async envAccountStatus() {
      return await envAccountStatus(k)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = null
      await stopOutbox(k)
    },
    async suppressedAmong(addresses: string[], { orgId }: { orgId?: string | null } = {}) {
      return await suppressedAmong(k.db, addresses, orgId ?? null)
    },
    async isSuppressed(address: string, { orgId }: { orgId?: string | null } = {}): Promise<false | SuppressionHit> {
      return await isSuppressed(k.db, address, orgId ?? null)
    },
    async resolveSender(stream: string, orgId?: string | null) {
      const s = streams.get(stream)
      if (!s) throw new Error(`Unknown mail stream "${stream}"`)
      const resolved = await resolveSenderRow(k, s, orgId ?? null)
      return resolved ? { domain: resolved.domain.domain, fromDomain: fromDomainOf(resolved.domain), accountId: resolved.account.id, domainOrgId: resolved.domain.org_id } : null
    },
    addressHash,

    // Webhooks (Nuxt app only).
    webhookToken: (account: Pick<MailAccountRow, 'id' | 'webhook_token_version'>) => webhookToken(k, account),
    webhookUrls: (account: Pick<MailAccountRow, 'id' | 'webhook_token_version'>, baseUrl: string) => webhookUrls(k, account, baseUrl),
    handleWebhook: (input: WebhookInput) => handleWebhook(k, input),
    handleEvents: (account: MailAccountRow, events: MailEvent[]) => handleEvents(k, account, events),
    dispatchInbound: (account: MailAccountRow, m: InboundMail) => dispatchInbound(k, account, m),

    admin: bindAdmin(k)
  }
  return mail
}

type Bound<T> = { [K in keyof T]: T[K] extends (k: Kernel, ...args: infer A) => infer R ? (...args: A) => R : never }

const ADMIN_FNS = {
  accountView: admin.accountView,
  domainKeyView: admin.domainKeyView,
  listAccounts: admin.listAccounts,
  getAccount: admin.getAccount,
  accountsByIds: admin.accountsByIds,
  createAccount: admin.createAccount,
  updateAccount: admin.updateAccount,
  deleteAccount: admin.deleteAccount,
  verifyAccount: admin.verifyAccount,
  rotateWebhooks: admin.rotateWebhooks,
  listDomains: admin.listDomains,
  getDomain: admin.getDomain,
  addDomain: admin.addDomain,
  patchDomain: admin.patchDomain,
  deleteDomain: admin.deleteDomain,
  deprovision: admin.deprovision,
  verifyOwnership: admin.verifyOwnership,
  checkDomain: admin.checkDomain,
  requiredEvents: admin.requiredEvents,
  postedEvents: admin.postedEvents,
  webhookStatus: admin.webhookStatus,
  manualSteps: admin.manualSteps,
  setStreamRoute: admin.setStreamRoute,
  streamsOverview: admin.streamsOverview,
  listSuppressions: admin.listSuppressions,
  clearSuppression: admin.clearSuppression,
  runDailyJob: admin.runDailyJob
}

function bindAdmin(k: Kernel): Bound<typeof ADMIN_FNS> {
  const out: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(ADMIN_FNS)) out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(k, ...args)
  return out as Bound<typeof ADMIN_FNS>
}

export type Mail = ReturnType<typeof createMail>
export type { Kernel }
