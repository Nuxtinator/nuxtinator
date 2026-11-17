// The env account: one provider key and one domain, read from the process
// environment when createMail runs. Its rows hold no credentials, so every
// sending process sends with its own environment; the fingerprint lets a
// process tell that its environment differs from the one the app recorded.
import { hmacHex } from './crypto'
import type { Credentials, MailProvider, MailTransport } from './types'

export type MailEnv = Record<string, string | undefined>

export interface EnvAccountConfig {
  provider: string | null
  credentials: Credentials
  domain: string
  fromDomain: string | null
  fromName: string | null
  fromLocal: string | null
}

export function readEnvAccount(env: MailEnv, providers: Map<string, MailProvider>): EnvAccountConfig | null {
  const domain = (env.MAIL_DOMAIN || env.MAILGUN_DOMAIN || '').trim().toLowerCase()
  if (!domain) return null

  const named = (env.MAIL_PROVIDER || '').trim()
  const provider = named || (env.MAILGUN_API_KEY ? 'mailgun' : null)
  if (provider && !providers.has(provider)) {
    throw new Error(`MAIL_PROVIDER names "${provider}", but no mail provider with that id is registered`)
  }

  const credentials: Credentials = {}
  if (provider) {
    for (const field of providers.get(provider)!.credentialFields) {
      const value = field.env ? env[field.env] : undefined
      if (value) credentials[field.key] = value
    }
  }

  const smtpFrom = (env.SMTP_FROM || '').trim()
  const at = smtpFrom.lastIndexOf('@')
  const fromLocal = at > 0 ? smtpFrom.slice(0, at) : null
  const fromAddrDomain = at > 0 ? smtpFrom.slice(at + 1).toLowerCase() : null

  return {
    provider,
    credentials,
    domain,
    fromDomain: fromAddrDomain && fromAddrDomain !== domain ? fromAddrDomain : null,
    fromName: (env.SMTP_FROM_NAME || '').trim() || null,
    fromLocal
  }
}

export function envFingerprint(key: Buffer, cfg: EnvAccountConfig): string {
  const creds = Object.keys(cfg.credentials).sort().map(k => [k, cfg.credentials[k]])
  return hmacHex(key, JSON.stringify([cfg.provider, cfg.domain, creds]))
}

export function readTransport(env: MailEnv): MailTransport {
  const named = (env.MAIL_TRANSPORT || '').trim()
  const mode = named || (env.NODE_ENV === 'development' ? 'smtp' : 'provider')
  if (mode === 'log') return 'log'
  if (mode === 'smtp') {
    return { smtp: { host: env.SMTP_HOST || 'localhost', port: Number.parseInt(env.SMTP_PORT || '1025', 10) } }
  }
  if (mode === 'provider') return 'provider'
  throw new Error(`MAIL_TRANSPORT must be provider, smtp or log; got "${mode}"`)
}
