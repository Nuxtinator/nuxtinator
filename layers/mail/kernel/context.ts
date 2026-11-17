// The internal state one createMail instance shares between its modules.
import type { Kysely } from 'kysely'
import type { OutboxKeyPair } from './crypto'
import type { DnsLookup } from './dns'
import type { EnvAccountConfig, MailEnv } from './env'
import type { MailDatabase, MailAccountRow, MailDomainRow } from './schema'
import type {
  Capabilities, Credentials, InboundHandler, MailEventHandler, MailProvider, MailStream,
  MailTransport, ProviderSuppressionMode, SendGuard
} from './types'
import { decryptJson } from './crypto'

export interface Kernel {
  db: Kysely<MailDatabase>
  providers: Map<string, MailProvider>
  streams: Map<string, MailStream>
  env: MailEnv
  envAccount: EnvAccountConfig | null
  envFingerprint: string | null
  secretKey: string | null
  outboxKeys: OutboxKeyPair | null
  outboxPublicKey: string
  webhookSecret: Buffer | null
  guards: SendGuard[]
  inboundHandlers: InboundHandler[]
  eventHandlers: MailEventHandler[]
  transport: MailTransport
  requestTimeoutMs: number
  leaseSeconds: number
  dns: DnsLookup
  log: (line: string) => void
  envCheck: { status: 'ok' | 'missing' | 'mismatch', at: number } | null
  claimToken: string
  stopped: boolean
}

export function requireSecret(k: Kernel, what: string): string {
  if (!k.secretKey) throw new Error(`This mail instance has no secret key, so it can't ${what}`)
  return k.secretKey
}

// The account's credentials: the env account's from this process's
// environment, a UI account's decrypted from its row.
export function accountCredentials(k: Kernel, account: MailAccountRow): Credentials {
  if (account.source === 'env') return { ...(k.envAccount?.credentials ?? {}) }
  if (!account.credentials) return {}
  return decryptJson<Credentials>(requireSecret(k, 'read provider credentials'), account.credentials)
}

// A domain's own credentials merged over its account's.
export function domainCredentials(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null): Credentials {
  const base = accountCredentials(k, account)
  if (!domain?.credentials) return base
  const own = decryptJson<Credentials>(requireSecret(k, 'read provider credentials'), domain.credentials)
  const merged = { ...base }
  for (const [key, value] of Object.entries(own)) if (value) merged[key] = value
  return merged
}

export function effectiveCapabilities(account: MailAccountRow, domain: MailDomainRow | null): Capabilities {
  return (domain?.capabilities as Capabilities | null) ?? (account.capabilities as Capabilities) ?? {}
}

export function suppressionMode(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null): ProviderSuppressionMode {
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  if (!provider) return 'unmanaged'
  return provider.providerSuppression.mode(effectiveCapabilities(account, domain))
}

// Runs `fn` with an AbortSignal that fires after `ms`; the timer is cleared
// by hand (AbortSignal.timeout leaks timers under Bun).
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<{ timedOut: false, value: T } | { timedOut: true }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ timedOut: true })
    }, ms)
  })
  try {
    return await Promise.race([
      fn(controller.signal).then(value => ({ timedOut: false as const, value })),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}
