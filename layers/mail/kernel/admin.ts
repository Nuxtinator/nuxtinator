// Account, domain, stream-route and suppression management. Callers decide
// who may do what (host admin, or an org's admins filtered to `orgId`); every
// function here takes the owning scope and refuses rows outside it.
import { sql } from 'kysely'
import { addressHash } from './address'
import {
  accountCredentials, domainCredentials, effectiveCapabilities, requireSecret, suppressionMode, type Kernel
} from './context'
import { encryptJson, randomToken } from './crypto'
import { jsonb } from './json'
import { PROBE_STREAM } from './events'
import { PROBE_PREFIX } from './inbound'
import { buildMessageHeaders } from './headers'
import { domainQualifies, resolveSenderRow } from './resolve'
import { webhookUrls } from './webhooks'
import type { Capabilities, DnsRecord, MailAccountRow, MailDomainRow, MailSuppressionRow, SuppressionReason } from './schema'
import {
  ProviderPermissionError, type CapabilityKey, type Credentials, type MailEventType, type MailProvider, type ManualStep,
  type WebhookUrls
} from './types'

export class MailAdminError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly data?: unknown) {
    super(message)
  }
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const PENDING_CLAIM_DAYS = 7
const LAPSE_AFTER_FAILURES = 3

export type Scope = { orgId: string | null }

function sameScope(row: { org_id: string | null }, scope: Scope): boolean {
  return (row.org_id ?? null) === (scope.orgId ?? null)
}

function providerOf(k: Kernel, id: string | null): MailProvider {
  const provider = id ? k.providers.get(id) : undefined
  if (!provider) throw new MailAdminError(422, `Unknown mail provider "${id}"`)
  return provider
}

// ---------- presentation ----------

export interface AccountView {
  id: string
  orgId: string | null
  source: 'ui' | 'env'
  provider: string | null
  providerLabel: string | null
  label: string
  credentials: Record<string, string>
  capabilities: Capabilities
  webhookTokenVersion: number
  createdAt: Date
}

function mask(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`
}

export function maskCredentials(provider: MailProvider | undefined, creds: Credentials, fields?: { key: string, secret: boolean }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of fields ?? provider?.credentialFields ?? []) {
    const value = creds[field.key]
    if (!value) continue
    out[field.key] = field.secret ? mask(value) : value
  }
  return out
}

export function accountView(k: Kernel, account: MailAccountRow): AccountView {
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  let creds: Credentials = {}
  try {
    creds = accountCredentials(k, account)
  } catch {
    creds = {}
  }
  return {
    id: account.id,
    orgId: account.org_id,
    source: account.source,
    provider: account.provider,
    providerLabel: provider?.label ?? null,
    label: account.source === 'env' ? 'Environment' : (account.label ?? provider?.label ?? 'Account'),
    credentials: maskCredentials(provider, creds),
    capabilities: (account.capabilities ?? {}) as Capabilities,
    webhookTokenVersion: account.webhook_token_version,
    createdAt: account.created_at
  }
}

// ---------- accounts ----------

export async function listAccounts(k: Kernel, scope: Scope): Promise<MailAccountRow[]> {
  let q = k.db.selectFrom('mail_accounts').selectAll()
  q = scope.orgId ? q.where('org_id', '=', scope.orgId) : q.where('org_id', 'is', null)
  return (await q.orderBy('created_at').execute()).sort((a, b) => (a.source === 'env' ? -1 : 0) - (b.source === 'env' ? -1 : 0))
}

export async function getAccount(k: Kernel, scope: Scope, id: string): Promise<MailAccountRow> {
  const row = await k.db.selectFrom('mail_accounts').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row || !sameScope(row, scope)) throw new MailAdminError(404, 'Account not found')
  return row
}

// Accounts by id, whatever their owner; for presenting domains.
export async function accountsByIds(k: Kernel, ids: (string | null)[]): Promise<Map<string, MailAccountRow>> {
  const wanted = [...new Set(ids.filter(Boolean) as string[])]
  if (wanted.length === 0) return new Map()
  const rows = await k.db.selectFrom('mail_accounts').selectAll().where('id', 'in', wanted).execute()
  return new Map(rows.map(r => [r.id, r]))
}

function cleanCredentials(provider: MailProvider, input: Record<string, unknown>, fields = provider.credentialFields): Credentials {
  const out: Credentials = {}
  for (const field of fields) {
    const v = input[field.key]
    if (typeof v === 'string' && v.trim()) out[field.key] = v.trim()
  }
  return out
}

function missingRequired(fields: { key: string, optional?: boolean, label: string }[], creds: Credentials): string[] {
  return fields.filter(f => !f.optional && !creds[f.key]).map(f => f.label)
}

export async function createAccount(k: Kernel, scope: Scope, input: { provider: string, label?: string | null, credentials: Record<string, unknown>, createdBy?: string | null }) {
  const secret = requireSecret(k, 'store provider credentials')
  const provider = providerOf(k, input.provider)
  const creds = cleanCredentials(provider, input.credentials)
  const missing = missingRequired(provider.credentialFields, creds)
  if (missing.length) throw new MailAdminError(422, `Missing: ${missing.join(', ')}`)
  const account = await k.db
    .insertInto('mail_accounts')
    .values({
      org_id: scope.orgId,
      source: 'ui',
      provider: provider.id,
      label: input.label?.trim() || null,
      credentials: encryptJson(secret, creds),
      capabilities: jsonb({}),
      created_by: input.createdBy ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  const verify = await verifyAccount(k, scope, account.id)
  return { account: verify.account, verify: verify.result }
}

export async function updateAccount(k: Kernel, scope: Scope, id: string, input: { label?: string | null, credentials?: Record<string, unknown> }) {
  const account = await getAccount(k, scope, id)
  if (account.source === 'env') throw new MailAdminError(409, 'The environment account is read-only')
  const provider = providerOf(k, account.provider)
  const patch: Record<string, unknown> = { updated_at: sql`now()` }
  if (input.label !== undefined) patch.label = input.label?.trim() || null
  let recheck = false
  if (input.credentials) {
    const merged = { ...accountCredentials(k, account), ...cleanCredentials(provider, input.credentials) }
    patch.credentials = encryptJson(requireSecret(k, 'store provider credentials'), merged)
    patch.capabilities = jsonb({})
    recheck = true
  }
  await k.db.updateTable('mail_accounts').set(patch).where('id', '=', id).execute()
  if (recheck) return (await verifyAccount(k, scope, id))
  return { account: await getAccount(k, scope, id), result: null }
}

export async function deleteAccount(k: Kernel, scope: Scope, id: string): Promise<void> {
  const account = await getAccount(k, scope, id)
  if (account.source === 'env') throw new MailAdminError(409, 'The environment account can\'t be deleted')
  const using = await k.db
    .selectFrom('mail_domains')
    .select('domain')
    .where(eb => eb.or([eb('send_account_id', '=', id), eb('receive_account_id', '=', id)]))
    .execute()
  if (using.length) {
    throw new MailAdminError(409, `This account is still used by ${using.map(d => d.domain).join(', ')}`, { domains: using.map(d => d.domain) })
  }
  await k.db.deleteFrom('mail_accounts').where('id', '=', id).execute()
}

function mergeCapabilities(prev: Capabilities, next: Capabilities): Capabilities {
  const out: Capabilities = { ...prev }
  for (const [key, value] of Object.entries(next) as [CapabilityKey, boolean | undefined][]) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export async function verifyAccount(k: Kernel, scope: Scope, id: string) {
  const account = await getAccount(k, scope, id)
  const provider = providerOf(k, account.provider)
  const firstDomain = await k.db
    .selectFrom('mail_domains')
    .selectAll()
    .where('send_account_id', '=', id)
    .where('credentials', 'is', null)
    .where('ownership_status', '=', 'verified')
    .orderBy('created_at')
    .executeTakeFirst()
  const result = await provider.verifyCredentials(accountCredentials(k, account), firstDomain?.domain, {
    probeAddress: firstDomain ? probeAddress(firstDomain) : undefined
  })
  if (result.ok) {
    await k.db.updateTable('mail_accounts')
      .set({ capabilities: jsonb(mergeCapabilities({}, result.capabilities)), updated_at: sql`now()` })
      .where('id', '=', id)
      .execute()
  }
  return { account: await getAccount(k, scope, id), result }
}

async function recordCapability(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null, key: CapabilityKey, value: boolean) {
  if (domain?.capabilities) {
    const caps = mergeCapabilities(domain.capabilities as Capabilities, { [key]: value })
    await k.db.updateTable('mail_domains').set({ capabilities: jsonb(caps) }).where('id', '=', domain.id).execute()
    domain.capabilities = caps
  } else {
    const caps = mergeCapabilities(account.capabilities as Capabilities, { [key]: value })
    await k.db.updateTable('mail_accounts').set({ capabilities: jsonb(caps) }).where('id', '=', account.id).execute()
    account.capabilities = caps
  }
}

// Runs a provider-side write. Success records the capability as proven; a
// permission refusal records it false and reports the manual path instead.
async function tryCapability<T>(k: Kernel, account: MailAccountRow, domain: MailDomainRow | null, key: CapabilityKey, fn: () => Promise<T>): Promise<{ ok: true, value: T } | { ok: false, refused: boolean, error: string }> {
  if (effectiveCapabilities(account, domain)[key] === false) return { ok: false, refused: true, error: `The key can't manage ${key}` }
  try {
    const value = await fn()
    if (effectiveCapabilities(account, domain)[key] !== true) await recordCapability(k, account, domain, key, true)
    return { ok: true, value }
  } catch (err) {
    if (err instanceof ProviderPermissionError) {
      await recordCapability(k, account, domain, err.capability, false)
      return { ok: false, refused: true, error: err.message }
    }
    return { ok: false, refused: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function rotateWebhooks(k: Kernel, scope: Scope, id: string, baseUrl: string) {
  const account = await getAccount(k, scope, id)
  await k.db.updateTable('mail_accounts')
    .set({ webhook_token_version: sql`webhook_token_version + 1`, updated_at: sql`now()` })
    .where('id', '=', id)
    .execute()
  const fresh = await getAccount(k, scope, id)
  const domains = await k.db.selectFrom('mail_domains').selectAll()
    .where(eb => eb.or([eb('send_account_id', '=', id), eb('receive_account_id', '=', id)]))
    .execute()
  const configured: string[] = []
  for (const domain of domains) {
    if (domain.setup_mode !== 'auto') {
      await k.db.updateTable('mail_domains').set({ webhook_events: null }).where('id', '=', domain.id).execute()
      continue
    }
    const res = await configureDomainWebhooks(k, fresh, domain, baseUrl)
    if (res.ok) configured.push(domain.domain)
  }
  return { account: fresh, urls: webhookUrls(k, fresh, baseUrl), configured, previousVersion: account.webhook_token_version }
}

// ---------- domains ----------

export function probeAddress(domain: Pick<MailDomainRow, 'probe_token' | 'domain'>): string {
  return `${PROBE_PREFIX}${domain.probe_token}@${domain.domain}`
}

export async function listDomains(k: Kernel, scope: Scope): Promise<MailDomainRow[]> {
  let q = k.db.selectFrom('mail_domains').selectAll()
  q = scope.orgId ? q.where('org_id', '=', scope.orgId) : q.where('org_id', 'is', null)
  return await q.orderBy('created_at').execute()
}

export async function getDomain(k: Kernel, scope: Scope, id: string): Promise<MailDomainRow> {
  const row = await k.db.selectFrom('mail_domains').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row || !sameScope(row, scope)) throw new MailAdminError(404, 'Domain not found')
  return row
}

async function accountForDomain(k: Kernel, scope: Scope, id: string | null | undefined): Promise<MailAccountRow | null> {
  if (!id) return null
  const account = await k.db.selectFrom('mail_accounts').selectAll().where('id', '=', id).executeTakeFirst()
  if (!account) throw new MailAdminError(422, 'Unknown account')
  // A domain may only use an account owned by the host or by its own org.
  if (account.org_id !== null && account.org_id !== scope.orgId) throw new MailAdminError(422, 'That account belongs to another organization')
  return account
}

export interface AddDomainInput {
  domain: string
  sendAccountId?: string | null
  receiveAccountId?: string | null
  setupMode?: 'auto' | 'manual'
  credentials?: Record<string, unknown> | null
  dkimSelector?: string | null
  fromDomain?: string | null
  makeDefault?: boolean
}

function normalizeDomain(value: string): string {
  const d = value.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN_PATTERN.test(d)) throw new MailAdminError(422, 'That isn\'t a valid domain name')
  return d
}

export async function addDomain(k: Kernel, scope: Scope, input: AddDomainInput, baseUrl: string) {
  const domain = normalizeDomain(input.domain)
  const sendAccount = await accountForDomain(k, scope, input.sendAccountId)
  const receiveAccount = await accountForDomain(k, scope, input.receiveAccountId)
  if (receiveAccount) {
    const provider = providerOf(k, receiveAccount.provider)
    if (!provider.supports.receive) throw new MailAdminError(422, `${provider.label} can't receive mail`)
  }
  if (sendAccount?.provider) {
    const provider = providerOf(k, sendAccount.provider)
    if (!provider.supports.send) throw new MailAdminError(422, `${provider.label} can't send mail`)
  }

  const holder = await k.db.selectFrom('mail_domains').select(['id', 'org_id'])
    .where(sql`lower(domain)`, '=', domain)
    .where('ownership_status', '=', 'verified')
    .executeTakeFirst()
  if (holder && sameScope(holder, scope)) throw new MailAdminError(409, 'This domain has already been added')
  if (holder && scope.orgId === null) throw new MailAdminError(409, 'An organization has already verified this domain')
  if (scope.orgId) {
    const pendingOwn = await k.db.selectFrom('mail_domains').select('id')
      .where(sql`lower(domain)`, '=', domain).where('org_id', '=', scope.orgId).executeTakeFirst()
    if (pendingOwn) throw new MailAdminError(409, 'This domain has already been added')
  }
  if (input.fromDomain && scope.orgId) throw new MailAdminError(422, 'Only host admins can set a separate From domain')

  let domainCreds: string | null = null
  let domainCaps: Capabilities | null = null
  const provider = sendAccount?.provider ? providerOf(k, sendAccount.provider) : null
  if (input.credentials && provider?.domainCredentialFields) {
    const creds = cleanCredentials(provider, input.credentials, provider.domainCredentialFields as never)
    if (Object.keys(creds).length) {
      domainCreds = encryptJson(requireSecret(k, 'store provider credentials'), creds)
      domainCaps = {}
    }
  }

  const row = await k.db.insertInto('mail_domains').values({
    org_id: scope.orgId,
    source: 'ui',
    domain,
    ownership_status: scope.orgId ? 'pending' : 'verified',
    ownership_token: scope.orgId ? randomToken(24) : null,
    from_domain: input.fromDomain ? normalizeDomain(input.fromDomain) : null,
    send_account_id: sendAccount?.id ?? null,
    receive_account_id: receiveAccount?.id ?? null,
    setup_mode: input.setupMode ?? 'auto',
    credentials: domainCreds,
    capabilities: domainCaps ? jsonb(domainCaps) : null,
    dkim_selector: input.dkimSelector?.trim() || null,
    probe_token: receiveAccount ? randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, '') : null,
    dns_records: jsonb([]),
    provider_refs: jsonb({}),
    verified_at: null
  }).returningAll().executeTakeFirstOrThrow()

  if (input.makeDefault && !scope.orgId) {
    await setStreamRoute(k, scope, '*', row.id, baseUrl, { skipQualify: true })
  }

  if (row.ownership_status !== 'verified') return { domain: row, setup: null }
  // A domain's own key gets its own capabilities, probed against the domain.
  if (domainCreds && sendAccount && provider) {
    const res = await provider.verifyCredentials(domainCredentials(k, sendAccount, row), domain, { probeAddress: row.probe_token ? probeAddress(row) : undefined })
    if (res.ok) await k.db.updateTable('mail_domains').set({ capabilities: jsonb(res.capabilities) }).where('id', '=', row.id).execute()
  }
  const setup = await setUpDomain(k, await getDomain(k, scope, row.id), baseUrl)
  return { domain: await getDomain(k, scope, row.id), setup }
}

// Role accounts and provider objects for a domain.
async function roleAccounts(k: Kernel, domain: MailDomainRow) {
  const ids = [domain.send_account_id, domain.receive_account_id].filter(Boolean) as string[]
  const rows = ids.length ? await k.db.selectFrom('mail_accounts').selectAll().where('id', 'in', ids).execute() : []
  const byId = new Map(rows.map(r => [r.id, r]))
  return {
    send: domain.send_account_id ? byId.get(domain.send_account_id) ?? null : null,
    receive: domain.receive_account_id ? byId.get(domain.receive_account_id) ?? null : null
  }
}

export interface DomainSetup {
  mxConflict: string[]
  roles: { role: 'send' | 'receive', mode: 'auto' | 'manual', error?: string }[]
}

// Registers the domain at each role's provider when the key can, and
// captures the DNS records to show. Manual domains only get a probe token
// and a DKIM-selector note.
async function setUpDomain(k: Kernel, domain: MailDomainRow, baseUrl: string): Promise<DomainSetup> {
  const accounts = await roleAccounts(k, domain)
  const setup: DomainSetup = { mxConflict: [], roles: [] }
  if (accounts.receive) {
    const mx = await k.dns.mx(domain.domain).catch(() => [])
    setup.mxConflict = mx.map(r => r.exchange)
  }
  let records: DnsRecord[] = []
  const refs: Record<string, unknown> = { ...(domain.provider_refs as Record<string, unknown>) }
  let dkimSelector = domain.dkim_selector
  for (const role of ['send', 'receive'] as const) {
    const account = accounts[role]
    if (!account) continue
    const provider = account.provider ? k.providers.get(account.provider) : undefined
    if (domain.setup_mode === 'manual' || !provider?.provisionDomain) {
      setup.roles.push({ role, mode: 'manual' })
      continue
    }
    const creds = domainCredentials(k, account, domain)
    const urls = webhookUrls(k, account, baseUrl)
    const res = await tryCapability(k, account, domain, role === 'send' ? 'domains' : 'routes', () => provider.provisionDomain!(creds, domain.domain, role, urls))
    if (res.ok) {
      records = [...records.filter(r => r.role !== role), ...res.value.records]
      refs[role] = res.value.refs ?? {}
      if (res.value.dkimSelector) dkimSelector = res.value.dkimSelector
      for (const [key, value] of Object.entries(res.value.capabilities ?? {}) as [CapabilityKey, boolean][]) {
        await recordCapability(k, account, domain, key, value)
      }
      setup.roles.push({ role, mode: 'auto' })
    } else {
      setup.roles.push({ role, mode: 'manual', error: res.error })
    }
  }
  const allManual = setup.roles.length > 0 && setup.roles.every(r => r.mode === 'manual')
  await k.db.updateTable('mail_domains').set({
    dns_records: jsonb(records),
    provider_refs: jsonb(refs),
    dkim_selector: dkimSelector,
    ...(allManual && domain.setup_mode === 'auto' ? { setup_mode: 'manual' as const } : {})
  }).where('id', '=', domain.id).execute()
  return setup
}

export interface PatchDomainInput {
  sendAccountId?: string | null
  receiveAccountId?: string | null
  credentials?: Record<string, unknown> | null
  fromDomain?: string | null
  dkimSelector?: string | null
  confirmWebhooks?: boolean
}

export async function patchDomain(k: Kernel, scope: Scope, id: string, input: PatchDomainInput, baseUrl: string) {
  const domain = await getDomain(k, scope, id)
  if (domain.ownership_status === 'pending' && (input.sendAccountId !== undefined || input.receiveAccountId !== undefined || input.confirmWebhooks)) {
    throw new MailAdminError(409, 'Confirm you own this domain first')
  }
  const patch: Record<string, unknown> = {}
  let resetup = false
  if (input.sendAccountId !== undefined) {
    const account = await accountForDomain(k, scope, input.sendAccountId)
    if (domain.source === 'env' && account?.id !== domain.send_account_id) throw new MailAdminError(409, 'The environment domain always sends through the environment account')
    patch.send_account_id = account?.id ?? null
    patch.send_status = 'pending'
    patch.send_error = null
    resetup = true
  }
  if (input.receiveAccountId !== undefined) {
    const account = await accountForDomain(k, scope, input.receiveAccountId)
    if (account && !providerOf(k, account.provider).supports.receive) throw new MailAdminError(422, 'That provider can\'t receive mail')
    patch.receive_account_id = account?.id ?? null
    patch.receive_status = 'pending'
    patch.probe_token = account ? (domain.probe_token ?? randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, '')) : null
    resetup = true
  }
  if (input.fromDomain !== undefined) {
    if (domain.source === 'env') throw new MailAdminError(409, 'The environment domain\'s From domain comes from SMTP_FROM')
    if (scope.orgId) throw new MailAdminError(422, 'Only host admins can set a separate From domain')
    patch.from_domain = input.fromDomain ? normalizeDomain(input.fromDomain) : null
  }
  if (input.dkimSelector !== undefined) patch.dkim_selector = input.dkimSelector?.trim() || null
  if (input.credentials !== undefined) {
    const account = await accountForDomain(k, scope, (patch.send_account_id as string | undefined) ?? domain.send_account_id)
    const provider = account?.provider ? providerOf(k, account.provider) : null
    const creds = input.credentials && provider?.domainCredentialFields
      ? cleanCredentials(provider, input.credentials, provider.domainCredentialFields as never)
      : {}
    patch.credentials = Object.keys(creds).length ? encryptJson(requireSecret(k, 'store provider credentials'), creds) : null
    patch.capabilities = Object.keys(creds).length ? jsonb({}) : null
    patch.send_error = null
  }
  if (input.confirmWebhooks) patch.webhook_events = jsonb(await requiredEvents(k, domain))
  if (Object.keys(patch).length) await k.db.updateTable('mail_domains').set(patch).where('id', '=', id).execute()

  let fresh = await getDomain(k, scope, id)
  if (input.credentials && fresh.credentials) {
    const { send } = await roleAccounts(k, fresh)
    if (send?.provider) {
      const provider = providerOf(k, send.provider)
      const res = await provider.verifyCredentials(domainCredentials(k, send, fresh), fresh.domain, { probeAddress: fresh.probe_token ? probeAddress(fresh) : undefined })
      if (res.ok) await k.db.updateTable('mail_domains').set({ capabilities: jsonb(res.capabilities) }).where('id', '=', id).execute()
    }
    fresh = await getDomain(k, scope, id)
  }
  const setup = resetup && fresh.ownership_status === 'verified' ? await setUpDomain(k, fresh, baseUrl) : null
  return { domain: await getDomain(k, scope, id), setup }
}

export async function deleteDomain(k: Kernel, scope: Scope, id: string): Promise<void> {
  const domain = await getDomain(k, scope, id)
  if (domain.source === 'env') throw new MailAdminError(409, 'The environment domain can\'t be deleted')
  await deprovision(k, domain)
  await k.db.deleteFrom('mail_domains').where('id', '=', id).execute()
}

// Best effort: removes the domain at each provider that registered it.
export async function deprovision(k: Kernel, domain: MailDomainRow): Promise<void> {
  if (domain.setup_mode !== 'auto') return
  const accounts = await roleAccounts(k, domain)
  const refs = domain.provider_refs as Record<string, Record<string, unknown>>
  const done = new Set<string>()
  for (const role of ['send', 'receive'] as const) {
    const account = accounts[role]
    if (!account || done.has(account.id)) continue
    done.add(account.id)
    const provider = account.provider ? k.providers.get(account.provider) : undefined
    if (!provider?.deprovisionDomain || !refs[role]) continue
    try {
      await provider.deprovisionDomain(domainCredentials(k, account, domain), domain.domain, refs[role] ?? {})
    } catch (err) {
      k.log(`[mail] deprovisioning ${domain.domain} at ${provider.id} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// The events a domain's webhooks must post: bounces, complaints and
// unsubscribes always; `delivered` only when the domain carries a
// userInitiated stream or a stream with a delivered handler.
export async function requiredEvents(k: Kernel, domain: MailDomainRow): Promise<MailEventType[]> {
  const events: MailEventType[] = ['bounced', 'complained', 'unsubscribed', 'rejected', 'dropped']
  const carried = await streamsOnDomain(k, domain)
  const wantsDelivered = carried.some(stream =>
    stream.userInitiated
    || k.eventHandlers.some(h => (!h.stream || h.stream === stream.id) && (!h.types || h.types.includes('delivered'))))
  if (wantsDelivered) events.unshift('delivered')
  return events
}

async function streamsOnDomain(k: Kernel, domain: MailDomainRow) {
  const out = []
  for (const stream of k.streams.values()) {
    const resolved = await resolveSenderRow(k, stream, domain.org_id)
    if (resolved?.domain.id === domain.id) out.push(stream)
  }
  return out
}

export async function webhookStatus(k: Kernel, domain: MailDomainRow): Promise<{ state: 'connected' | 'needs_update' | 'not_configured', required: MailEventType[] }> {
  const required = await requiredEvents(k, domain)
  const configured = domain.webhook_events as string[] | null
  if (!configured) return { state: 'not_configured', required }
  const same = configured.length === required.length && required.every(e => configured.includes(e))
  return { state: same ? 'connected' : 'needs_update', required }
}

// A provider whose event webhook belongs to the account gets the events
// every one of the account's domains needs.
async function webhookEventsFor(k: Kernel, provider: MailProvider, account: MailAccountRow, domain: MailDomainRow): Promise<MailEventType[]> {
  if (provider.webhookScope !== 'account') return await requiredEvents(k, domain)
  const domains = await k.db.selectFrom('mail_domains').selectAll()
    .where(eb => eb.or([eb('send_account_id', '=', account.id), eb('receive_account_id', '=', account.id)]))
    .where('ownership_status', '=', 'verified')
    .execute()
  const all = new Set<MailEventType>()
  for (const d of domains) for (const e of await requiredEvents(k, d)) all.add(e)
  return [...all]
}

async function configureDomainWebhooks(k: Kernel, account: MailAccountRow, domain: MailDomainRow, baseUrl: string) {
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  if (!provider?.configureWebhooks || !provider.supports.events) return { ok: false as const, refused: false, error: 'not supported' }
  const events = await webhookEventsFor(k, provider, account, domain)
  const res = await tryCapability(k, account, domain, 'webhooks', () =>
    provider.configureWebhooks!(domainCredentials(k, account, domain), domain.domain, webhookUrls(k, account, baseUrl), { delivered: events.includes('delivered'), events }))
  if (!res.ok) return res
  const issued = res.value && typeof res.value === 'object' ? res.value.credentials : undefined
  if (issued && account.source === 'ui') {
    const merged = { ...accountCredentials(k, account), ...issued }
    await k.db.updateTable('mail_accounts')
      .set({ credentials: encryptJson(requireSecret(k, 'store provider credentials'), merged), updated_at: sql`now()` })
      .where('id', '=', account.id)
      .execute()
  } else if (issued) {
    k.log(`[mail] ${provider.label} issued credentials (${Object.keys(issued).join(', ')}) for the environment account; set them in its environment variables`)
  }
  const ids = provider.webhookScope === 'account'
    ? (await k.db.selectFrom('mail_domains').select('id').where(eb => eb.or([eb('send_account_id', '=', account.id), eb('receive_account_id', '=', account.id)])).execute()).map(r => r.id)
    : [domain.id]
  for (const id of ids) {
    const d = await k.db.selectFrom('mail_domains').selectAll().where('id', '=', id).executeTakeFirst()
    if (d) await k.db.updateTable('mail_domains').set({ webhook_events: jsonb(await requiredEvents(k, d)) }).where('id', '=', id).execute()
  }
  return res
}

export interface RoleCheck {
  role: 'send' | 'receive'
  status: 'pending' | 'verified' | 'failed'
  checks: { key: string, label: string, ok: boolean | null, detail?: string }[]
  error?: string
}

export interface DomainCheck {
  ownership?: { ok: boolean, record: { name: string, value: string } }
  roles: RoleCheck[]
  webhooks?: { ok: boolean, error?: string }
  setup?: DomainSetup | null
}

export function ownershipRecord(domain: Pick<MailDomainRow, 'domain' | 'ownership_token'>) {
  return { type: 'TXT' as const, name: `_nx-verify.${domain.domain}`, value: `nx-verify=${domain.ownership_token}` }
}

async function checkOwnership(k: Kernel, domain: MailDomainRow): Promise<boolean | null> {
  try {
    const txt = await k.dns.txt(`_nx-verify.${domain.domain}`)
    return txt.some(v => v.trim() === `nx-verify=${domain.ownership_token}`)
  } catch {
    return null
  }
}

// Confirms the org's TXT challenge. The first claim to verify owns the name;
// every other row for it is deleted.
export async function verifyOwnership(k: Kernel, scope: Scope, id: string, baseUrl: string) {
  const domain = await getDomain(k, scope, id)
  if (domain.ownership_status === 'verified') return { ok: true, domain, setup: null }
  const ok = await checkOwnership(k, domain)
  if (!ok) return { ok: false, domain, setup: null }
  await k.db.transaction().execute(async (tx) => {
    const holder = await tx.selectFrom('mail_domains').select('id')
      .where(sql`lower(domain)`, '=', domain.domain)
      .where('ownership_status', '=', 'verified')
      .where('id', '!=', domain.id)
      .where(eb => eb.or([eb('org_id', 'is', null), eb('source', '=', 'env')]))
      .executeTakeFirst()
    if (holder) throw new MailAdminError(409, 'This domain is in use by the host')
    await tx.deleteFrom('mail_domains').where(sql`lower(domain)`, '=', domain.domain).where('id', '!=', domain.id).execute()
    await tx.updateTable('mail_domains')
      .set({ ownership_status: 'verified', ownership_failures: 0 })
      .where('id', '=', domain.id)
      .execute()
  })
  const fresh = await getDomain(k, scope, id)
  const setup = await setUpDomain(k, fresh, baseUrl)
  return { ok: true, domain: await getDomain(k, scope, id), setup }
}

async function manualSendDnsChecks(k: Kernel, domain: MailDomainRow): Promise<RoleCheck['checks']> {
  const spf = (await k.dns.txt(domain.domain).catch(() => [])).find(v => v.toLowerCase().startsWith('v=spf1'))
  const dkimName = domain.dkim_selector ? `${domain.dkim_selector}._domainkey.${domain.domain}` : null
  const dkim = dkimName
    ? ((await k.dns.txt(dkimName).catch(() => [])).some(v => /p=/.test(v)) || (await k.dns.cname(dkimName).catch(() => [])).length > 0)
    : null
  const dmarcAt = domain.from_domain || domain.domain
  const dmarc = (await k.dns.txt(`_dmarc.${dmarcAt}`).catch(() => [])).some(v => v.toLowerCase().startsWith('v=dmarc1'))
  return [
    { key: 'spf', label: `SPF record at ${domain.domain}`, ok: !!spf, detail: spf },
    { key: 'dkim', label: dkimName ? `DKIM record at ${dkimName}` : 'DKIM selector not set', ok: dkim },
    { key: 'dmarc', label: `DMARC record at _dmarc.${dmarcAt}`, ok: dmarc }
  ]
}

// A probe mail to the domain's receiving probe address, sent from the
// domain itself when it can send, else through the default sender.
async function sendProbe(k: Kernel, domain: MailDomainRow, account: MailAccountRow | null): Promise<string | null> {
  if (!domain.probe_token) return 'no probe address'
  const sender = account && domain.send_status === 'verified' ? { domain, account } : null
  const fallback = sender ?? await resolveSenderRow(k, { id: PROBE_STREAM, label: 'Probe', defaultLocal: 'postmaster', orgAssignable: false }, null)
  if (!fallback) return 'No domain can send the probe yet'
  if (k.transport !== 'provider') return null
  const provider = fallback.account.provider ? k.providers.get(fallback.account.provider) : undefined
  if (!provider) return 'The sending account has no provider'
  const from = `postmaster@${fallback.domain.from_domain || fallback.domain.domain}`
  const messageId = `<${randomToken(18)}@${fallback.domain.domain}>`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), k.requestTimeoutMs)
  try {
    const res = await provider.send(domainCredentials(k, fallback.account, fallback.domain), {
      from: { name: null, address: from },
      domain: fallback.domain.domain,
      to: probeAddress(domain),
      replyTo: null,
      subject: 'Receiving check',
      html: '<p>This message checks that the domain can receive mail.</p>',
      text: 'This message checks that the domain can receive mail.',
      messageId,
      headers: buildMessageHeaders({ stream: PROBE_STREAM, to: probeAddress(domain), subject: '', html: '' }, messageId),
      attachments: [],
      correlation: { stream: PROBE_STREAM, orgId: null, ref: null },
      bypassProviderSuppression: false,
      signal: controller.signal
    })
    return res.status === 'sent' ? null : (res.status === 'failed' ? res.error : res.error)
  } finally {
    clearTimeout(timer)
  }
}

export async function checkDomain(k: Kernel, scope: Scope, id: string, baseUrl: string): Promise<DomainCheck> {
  let domain = await getDomain(k, scope, id)
  const result: DomainCheck = { roles: [] }
  if (domain.ownership_status !== 'verified') {
    const own = await verifyOwnership(k, scope, id, baseUrl)
    result.ownership = { ok: own.ok, record: ownershipRecord(domain) }
    if (!own.ok) return result
    result.setup = own.setup
    domain = own.domain
  }
  const accounts = await roleAccounts(k, domain)
  const patch: Record<string, unknown> = { last_checked_at: sql`now()` }
  let records = [...(domain.dns_records as DnsRecord[])]

  for (const role of ['send', 'receive'] as const) {
    const account = accounts[role]
    if (!account) continue
    const provider = account.provider ? k.providers.get(account.provider) : undefined
    const check: RoleCheck = { role, status: 'pending', checks: [] }

    if (domain.setup_mode === 'auto' && provider?.checkDomain) {
      const refs = ((domain.provider_refs as Record<string, Record<string, unknown>>)[role]) ?? {}
      try {
        const res = await provider.checkDomain(domainCredentials(k, account, domain), domain.domain, role, refs)
        check.status = res.status
        if (res.error) check.error = res.error
        records = [...records.filter(r => r.role !== role), ...res.records]
        for (const r of res.records) check.checks.push({ key: `${r.type}:${r.name}`, label: `${r.type} ${r.name}`, ok: r.status === 'verified' ? true : r.status === 'failed' ? false : null })
      } catch (err) {
        check.status = 'failed'
        check.error = err instanceof Error ? err.message : String(err)
      }
    } else if (role === 'send') {
      if (!provider || k.transport !== 'provider') {
        check.checks.push({ key: 'provider', label: 'Provider accepted a test', ok: k.transport !== 'provider' ? true : false, detail: k.transport !== 'provider' ? 'Local transport: nothing is sent to a provider' : 'No provider' })
        check.status = k.transport !== 'provider' ? 'verified' : 'failed'
      } else {
        const res = await provider.verifyCredentials(domainCredentials(k, account, domain), domain.domain, { probeAddress: domain.probe_token ? probeAddress(domain) : `${PROBE_PREFIX}send@${domain.domain}` })
        const accepted = res.ok && res.capabilities.send === true
        check.checks.push({ key: 'provider', label: 'Provider accepted a test', ok: accepted, detail: res.ok ? undefined : res.error })
        if (res.ok && domain.credentials) patch.capabilities = jsonb(res.capabilities)
        check.status = accepted ? 'verified' : 'failed'
        if (!accepted) check.error = res.ok ? 'The key can\'t send for this domain' : res.error
      }
      const dns = await manualSendDnsChecks(k, domain)
      check.checks.push({ key: 'dns', label: 'DNS: SPF, DKIM and DMARC records found', ok: dns.every(d => d.ok !== false), detail: dns.filter(d => d.ok === false).map(d => d.label).join('; ') || undefined })
      check.checks.push(...dns)
    } else {
      if (domain.receive_status !== 'verified') {
        const error = await sendProbe(k, domain, accounts.send)
        check.checks.push({ key: 'probe', label: `Probe sent to ${probeAddress(domain)}`, ok: error ? false : null, detail: error ?? 'Waiting for it to arrive' })
        check.status = 'pending'
      } else {
        check.status = 'verified'
        check.checks.push({ key: 'probe', label: 'Probe received', ok: true })
      }
    }

    if (role === 'send') {
      // The receiving probe below may go out from this domain.
      domain.send_status = check.status
      patch.send_status = check.status
      if (check.status === 'verified') patch.send_error = null
    } else if (check.status !== 'pending' || domain.receive_status !== 'verified') {
      patch.receive_status = domain.receive_status === 'verified' && check.status === 'pending' ? 'verified' : check.status
    }
    result.roles.push(check)
  }

  patch.dns_records = jsonb(records)
  const anyVerified = result.roles.some(r => r.status === 'verified')
  if (anyVerified && !domain.verified_at) patch.verified_at = sql`now()`
  await k.db.updateTable('mail_domains').set(patch).where('id', '=', domain.id).execute()

  if (domain.setup_mode === 'auto') {
    const eventsAccount = accounts.send ?? accounts.receive
    if (eventsAccount) {
      const fresh = await getDomain(k, scope, id)
      const res = await configureDomainWebhooks(k, eventsAccount, fresh, baseUrl)
      result.webhooks = res.ok ? { ok: true } : { ok: false, error: res.error }
    }
  }
  return result
}

export function manualSteps(k: Kernel, account: MailAccountRow, domain: MailDomainRow, role: 'send' | 'receive', urls: WebhookUrls, events: MailEventType[]): ManualStep[] {
  const provider = account.provider ? k.providers.get(account.provider) : undefined
  if (!provider) return []
  return provider.manualSetup(domain.domain, role, urls, { events })
}

// ---------- streams ----------

export async function setStreamRoute(k: Kernel, scope: Scope, streamId: string, domainId: string | null, baseUrl: string, opts: { skipQualify?: boolean } = {}) {
  const stream = streamId === '*' ? null : k.streams.get(streamId)
  if (streamId !== '*' && !stream) throw new MailAdminError(404, 'Unknown stream')
  if (stream && scope.orgId && !stream.orgAssignable) throw new MailAdminError(422, 'This stream always uses the host\'s domain')

  const before = await k.db.selectFrom('mail_stream_routes').selectAll()
    .where('stream', '=', streamId)
    .where(eb => scope.orgId ? eb('org_id', '=', scope.orgId) : eb('org_id', 'is', null))
    .executeTakeFirst()

  if (domainId === null) {
    if (before) await k.db.deleteFrom('mail_stream_routes').where('id', '=', before.id).execute()
  } else {
    const domain = await getDomain(k, scope, domainId)
    if (!opts.skipQualify) {
      if (domain.ownership_status !== 'verified') throw new MailAdminError(409, 'Confirm you own this domain first')
      if (streamId === '*' && scope.orgId && domain.send_status !== 'verified') throw new MailAdminError(409, 'This domain can\'t send yet')
      if (stream && !domainQualifies(domain, stream, 'route')) {
        throw new MailAdminError(422, stream.needsReceive ? 'This stream needs a domain that can receive replies' : 'This domain can\'t send')
      }
    }
    await sql`
      INSERT INTO mail_stream_routes (org_id, stream, domain_id)
      VALUES (${scope.orgId}, ${streamId}, ${domainId})
      ON CONFLICT ((coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid)), stream) DO UPDATE SET domain_id = excluded.domain_id
    `.execute(k.db)
  }

  // Event lists follow which streams a domain carries.
  const touched = [before?.domain_id, domainId].filter(Boolean) as string[]
  for (const id of new Set(touched)) {
    const domain = await k.db.selectFrom('mail_domains').selectAll().where('id', '=', id).executeTakeFirst()
    if (!domain || domain.setup_mode !== 'auto' || domain.webhook_events === null) continue
    const accounts = await roleAccounts(k, domain)
    const account = accounts.send ?? accounts.receive
    const status = await webhookStatus(k, domain)
    if (account && status.state === 'needs_update') await configureDomainWebhooks(k, account, domain, baseUrl)
  }
}

export interface StreamOverview {
  id: string
  label: string
  orgAssignable: boolean
  needsReceive: boolean
  userInitiated: boolean
  bulk: boolean
  routeDomainId: string | null
  resolvedDomain: string | null
  qualifyingDomainIds: string[]
  bulkWarning: boolean
}

export async function streamsOverview(k: Kernel, scope: Scope): Promise<{ defaultDomainId: string | null, streams: StreamOverview[] }> {
  const routes = await k.db.selectFrom('mail_stream_routes').selectAll()
    .where(eb => scope.orgId ? eb('org_id', '=', scope.orgId) : eb('org_id', 'is', null))
    .execute()
  const domains = await listDomains(k, scope)
  const routeOf = (s: string) => routes.find(r => r.stream === s)?.domain_id ?? null
  const out: StreamOverview[] = []
  const deliveredDomains = new Set<string>()
  for (const d of domains) if ((await requiredEvents(k, d)).includes('delivered')) deliveredDomains.add(d.id)

  for (const stream of k.streams.values()) {
    if (scope.orgId && !stream.orgAssignable) continue
    const resolved = await resolveSenderRow(k, stream, scope.orgId)
    out.push({
      id: stream.id,
      label: stream.label,
      orgAssignable: stream.orgAssignable,
      needsReceive: !!stream.needsReceive,
      userInitiated: !!stream.userInitiated,
      bulk: !!stream.bulk,
      routeDomainId: routeOf(stream.id),
      resolvedDomain: resolved?.domain.domain ?? null,
      qualifyingDomainIds: domains.filter(d => domainQualifies(d, stream, 'route')).map(d => d.id),
      bulkWarning: !!stream.bulk && !!resolved && deliveredDomains.has(resolved.domain.id)
    })
  }
  return { defaultDomainId: routeOf('*'), streams: out }
}

// ---------- suppressions ----------

export interface SuppressionView {
  id: string
  reason: SuppressionReason
  scope: 'global' | 'host' | 'org'
  orgId: string | null
  source: string | null
  detail: string | null
  occurredAt: Date
  createdAt: Date
  clearedAt: Date | null
  clearedReason: string | null
  address?: string
}

function suppressionView(row: MailSuppressionRow, address?: string): SuppressionView {
  return {
    id: row.id,
    reason: row.reason,
    scope: row.scope,
    orgId: row.org_id,
    source: row.source,
    detail: row.detail,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
    clearedReason: row.cleared_reason,
    ...(address ? { address } : {})
  }
}

export async function listSuppressions(k: Kernel, scope: Scope & { all?: boolean }, opts: { reason?: SuppressionReason, address?: string, includeCleared?: boolean, limit?: number } = {}): Promise<SuppressionView[]> {
  let q = k.db.selectFrom('mail_suppressions').selectAll()
  if (!opts.includeCleared) q = q.where('cleared_at', 'is', null)
  if (opts.reason) q = q.where('reason', '=', opts.reason)
  if (opts.address) q = q.where('address_hash', '=', addressHash(opts.address))
  if (scope.orgId) {
    // An org sees its own rows, and global hard bounces only for an address it searched.
    q = q.where(eb => opts.address
      ? eb.or([eb('org_id', '=', scope.orgId!), eb('scope', '=', 'global')])
      : eb('org_id', '=', scope.orgId!))
  }
  const rows = await q.orderBy('created_at', 'desc').limit(Math.min(opts.limit ?? 200, 1000)).execute()
  return rows.map(r => suppressionView(r, opts.address?.trim().toLowerCase()))
}

export async function clearSuppression(k: Kernel, scope: Scope, id: string, address?: string): Promise<SuppressionView> {
  const row = await k.db.selectFrom('mail_suppressions').selectAll().where('id', '=', id).executeTakeFirst()
  if (!row) throw new MailAdminError(404, 'Suppression not found')
  if (scope.orgId && row.org_id !== scope.orgId) throw new MailAdminError(404, 'Suppression not found')
  const cleared = await k.db.updateTable('mail_suppressions')
    .set({ cleared_at: sql`now()`, cleared_reason: 'admin' })
    .where('id', '=', id)
    .where('cleared_at', 'is', null)
    .returningAll()
    .executeTakeFirst()
  if (address && addressHash(address) === row.address_hash) {
    await releaseEverywhere(k, row, address)
  }
  return suppressionView(cleared ?? row, address)
}

// After an admin clear, removes the address from each mirrored provider list
// that could still block it.
async function releaseEverywhere(k: Kernel, row: MailSuppressionRow, address: string): Promise<void> {
  let q = k.db.selectFrom('mail_domains').selectAll().where('ownership_status', '=', 'verified').where('send_account_id', 'is not', null)
  if (row.scope === 'org') q = q.where(eb => eb.or([eb('org_id', '=', row.org_id), eb('org_id', 'is', null)]))
  else if (row.scope === 'host') q = q.where('org_id', 'is', null)
  const domains = await q.execute()
  for (const domain of domains) {
    const account = await k.db.selectFrom('mail_accounts').selectAll().where('id', '=', domain.send_account_id!).executeTakeFirst()
    if (!account?.provider) continue
    const provider = k.providers.get(account.provider)
    if (!provider?.providerSuppression.release || suppressionMode(k, account, domain) !== 'mirrored') continue
    try {
      await provider.providerSuppression.release(domainCredentials(k, account, domain), domain.domain, address, row.reason === 'complaint' ? 'complaint' : 'bounce')
    } catch (err) {
      k.log(`[mail] provider release on ${domain.domain} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// ---------- the daily job ----------

export interface MailAlert {
  kind: 'role_lost' | 'ownership_lapsed'
  orgId: string | null
  domain: string
  role?: 'send' | 'receive'
}

export async function runDailyJob(k: Kernel, opts: { baseUrl: string, onAlert?: (alert: MailAlert) => Promise<void> }): Promise<void> {
  // Pending org claims older than a week.
  await k.db.deleteFrom('mail_domains')
    .where('ownership_status', '=', 'pending')
    .where('created_at', '<', sql<Date>`now() - make_interval(days => ${PENDING_CLAIM_DAYS})`)
    .execute()

  // Org ownership recheck.
  const owned = await k.db.selectFrom('mail_domains').selectAll()
    .where('org_id', 'is not', null)
    .where('ownership_status', 'in', ['verified', 'lapsed'])
    .execute()
  for (const domain of owned) {
    const ok = await checkOwnership(k, domain)
    if (ok === null) continue
    if (ok) {
      if (domain.ownership_status === 'lapsed') {
        const taken = await k.db.selectFrom('mail_domains').select('id')
          .where(sql`lower(domain)`, '=', domain.domain).where('ownership_status', '=', 'verified').where('id', '!=', domain.id)
          .executeTakeFirst()
        if (taken) continue
      }
      await k.db.updateTable('mail_domains').set({ ownership_status: 'verified', ownership_failures: 0 }).where('id', '=', domain.id).execute()
      continue
    }
    const failures = domain.ownership_failures + 1
    const lapse = domain.ownership_status === 'verified' && failures >= LAPSE_AFTER_FAILURES
    await k.db.updateTable('mail_domains')
      .set({ ownership_failures: failures, ...(lapse ? { ownership_status: 'lapsed' as const } : {}) })
      .where('id', '=', domain.id)
      .execute()
    if (lapse) await opts.onAlert?.({ kind: 'ownership_lapsed', orgId: domain.org_id, domain: domain.domain })
  }

  // Role rechecks on automatically set-up domains.
  const auto = await k.db.selectFrom('mail_domains').selectAll()
    .where('setup_mode', '=', 'auto')
    .where('ownership_status', '=', 'verified')
    .execute()
  for (const domain of auto) {
    const before = { send: domain.send_status, receive: domain.receive_status }
    try {
      const res = await checkDomain(k, { orgId: domain.org_id }, domain.id, opts.baseUrl)
      for (const role of res.roles) {
        if (before[role.role] === 'verified' && role.status === 'failed') {
          await opts.onAlert?.({ kind: 'role_lost', orgId: domain.org_id, domain: domain.domain, role: role.role })
        }
      }
    } catch (err) {
      k.log(`[mail] daily recheck of ${domain.domain} failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}
