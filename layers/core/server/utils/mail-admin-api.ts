// The handlers behind the host's /api/admin/mail/* routes and the org's
// /api/mail/org/* routes. Callers authorize first and pass the scope; these
// only ever touch rows of that scope.
import type { H3Event } from 'h3'
import { z } from 'zod'
import { effectiveCapabilities, ownershipRecord, probeAddress, type Mail, type MailAccountRow, type MailDomainRow, type ManualStep, type WebhookUrls } from '@nuxtinator/mail/kernel'
import { db } from './database'
import { hostOrgMailAccounts, mailAdmin, mailBaseUrl } from './mail-host'

export type MailScope = { orgId: string | null, hostAccounts?: { send: string | null, receive: string | null } }

// An org's domains may use its own accounts and, of the host's, only the
// ones the host designates for org domains.
async function domainScope(scope: MailScope): Promise<MailScope> {
  return scope.orgId ? { ...scope, hostAccounts: await hostOrgMailAccounts() } : scope
}

// Steps done in an account the org can't reach: the org is told to hand
// them to the host's admins, and the webhook URLs are left out.
function hostSideSteps(steps: ManualStep[], providerLabel: string, urls: WebhookUrls): ManualStep[] {
  if (!steps.length) return []
  const hidden = new Set(Object.values(urls))
  return [
    { title: `These steps are done in the host's ${providerLabel} account`, detail: 'Send them to your host\'s admins. Add any DNS records they give you at your DNS provider, then choose Check now.' },
    ...steps.map(step => ({ ...step, values: step.values?.filter(v => !hidden.has(v.value)) }))
  ]
}

function providerCatalog(mail: Mail) {
  return mail.providers.map(p => ({
    id: p.id,
    label: p.label,
    credentialFields: p.credentialFields.map(({ env: _env, ...f }) => f),
    domainCredentialFields: p.domainCredentialFields ?? [],
    supports: p.supports,
    webhookScope: p.webhookScope,
    notes: p.notes ?? {}
  }))
}

async function accountsById(mail: Mail, ids: (string | null)[]) {
  return await mail.admin.accountsByIds(ids)
}

function accountPayload(mail: Mail, account: MailAccountRow) {
  return {
    ...mail.admin.accountView(account),
    webhookUrls: account.provider ? mail.webhookUrls(account, mailBaseUrl()) : null
  }
}

type OrgNames = (orgIds: string[]) => Promise<Map<string, string>>
let orgNames: OrgNames | null = null

// The tenancy layer tells core how to name an org on the host's pages.
export function setMailOrgNameResolver(fn: OrgNames): void {
  orgNames = fn
}

// Every org's own accounts, for the host's read-only view of them.
async function orgOwnedAccounts(mail: Mail) {
  const rows = await db.selectFrom('mail_accounts').selectAll().where('org_id', 'is not', null).orderBy('created_at').execute()
  if (!rows.length) return []
  const names = orgNames ? await orgNames([...new Set(rows.map(r => r.org_id!))]) : new Map<string, string>()
  return rows.map(a => ({ ...mail.admin.accountView(a), webhookUrls: null, orgName: names.get(a.org_id!) ?? null }))
}

// The host account the host designates for receiving on org domains, as an org may pick it.
async function hostReceiveOption(mail: Mail) {
  const { receive } = await hostOrgMailAccounts()
  if (!receive) return null
  const row = await db.selectFrom('mail_accounts').select(['id', 'provider']).where('id', '=', receive).executeTakeFirst()
  if (!row?.provider) return null
  return { id: row.id, provider: row.provider }
}

export async function listMailAccounts(scope: MailScope) {
  return await mailAdmin(async (mail) => {
    const accounts = await mail.admin.listAccounts(scope)
    return {
      accounts: accounts.map(a => accountPayload(mail, a)),
      orgAccounts: scope.orgId ? [] : await orgOwnedAccounts(mail),
      hostReceiveAccount: scope.orgId ? await hostReceiveOption(mail) : null,
      providers: providerCatalog(mail),
      outboxPublicKey: scope.orgId ? null : mail.outboxPublicKey,
      transport: typeof mail.transport === 'object' ? 'smtp' : mail.transport
    }
  })
}

const accountBody = z.object({
  provider: z.string().min(1).optional(),
  label: z.string().max(200).nullable().optional(),
  credentials: z.record(z.string(), z.string()).optional()
})

export async function createMailAccount(event: H3Event, scope: MailScope, userId: string | null) {
  const body = accountBody.parse(await readBody(event))
  if (!body.provider) throw createError({ statusCode: 422, statusMessage: 'Choose a provider' })
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.createAccount(scope, { provider: body.provider!, label: body.label, credentials: body.credentials ?? {}, createdBy: userId })
    return { account: accountPayload(mail, res.account), verify: res.verify }
  })
}

export async function updateMailAccount(event: H3Event, scope: MailScope, id: string) {
  const body = accountBody.parse(await readBody(event))
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.updateAccount(scope, id, { label: body.label, credentials: body.credentials })
    return { account: accountPayload(mail, res.account), verify: res.result }
  })
}

export async function deleteMailAccount(scope: MailScope, id: string) {
  await mailAdmin(mail => mail.admin.deleteAccount(scope, id))
  return { ok: true }
}

export async function verifyMailAccount(scope: MailScope, id: string) {
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.verifyAccount(scope, id)
    return { account: accountPayload(mail, res.account), verify: res.result }
  })
}

export async function rotateMailWebhooks(scope: MailScope, id: string) {
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.rotateWebhooks(scope, id, mailBaseUrl())
    return { account: accountPayload(mail, res.account), urls: res.urls, configured: res.configured }
  })
}

// Webhook URLs carry the account's token, so an org sees them only for its own accounts.
async function domainPayload(mail: Mail, domain: MailDomainRow, accounts: Map<string, MailAccountRow>) {
  const send = domain.send_account_id ? accounts.get(domain.send_account_id) ?? null : null
  const receive = domain.receive_account_id ? accounts.get(domain.receive_account_id) ?? null : null
  const events = await mail.admin.postedEvents(domain)
  const webhooks = await mail.admin.webhookStatus(domain)
  const eventsAccount = send ?? receive
  const visible = (a: MailAccountRow | null) => !!a && (domain.org_id === null || a.org_id === domain.org_id)
  const urls = eventsAccount && visible(eventsAccount) ? mail.webhookUrls(eventsAccount, mailBaseUrl()) : null
  const provider = (a: MailAccountRow | null) => a?.provider ? mail.providers.find(p => p.id === a.provider) ?? null : null
  const steps = (a: MailAccountRow | null, role: 'send' | 'receive'): ManualStep[] => {
    if (!a) return []
    const accountUrls = mail.webhookUrls(a, mailBaseUrl())
    const list = mail.admin.manualSteps(a, domain, role, accountUrls, events)
    return visible(a) ? list : hostSideSteps(list, provider(a)?.label ?? 'provider', accountUrls)
  }
  const caps = (send ? effectiveCapabilities(send, domain) : domain.capabilities ?? {}) as Record<string, boolean>
  const sendProvider = provider(send)
  // A role set up automatically holds the provider's refs; one that fell back to manual doesn't.
  const refs = (domain.provider_refs ?? {}) as Record<string, unknown>
  const roleMode = (role: 'send' | 'receive') => domain.setup_mode === 'auto' && refs[role] ? 'auto' as const : 'manual' as const
  return {
    id: domain.id,
    orgId: domain.org_id,
    source: domain.source,
    domain: domain.domain,
    fromDomain: domain.from_domain,
    ownershipStatus: domain.ownership_status,
    ownershipRecord: domain.ownership_token ? ownershipRecord(domain) : null,
    setupMode: domain.setup_mode,
    roleModes: { send: roleMode('send'), receive: roleMode('receive') },
    sendAccountId: domain.send_account_id,
    receiveAccountId: domain.receive_account_id,
    sendProvider: sendProvider ? { id: sendProvider.id, label: sendProvider.label } : (send ? { id: null, label: 'None' } : null),
    receiveProvider: provider(receive) ? { id: provider(receive)!.id, label: provider(receive)!.label } : null,
    sendStatus: domain.send_status,
    receiveStatus: domain.receive_status,
    sendError: domain.send_error,
    hasOwnCredentials: !!domain.credentials,
    capabilities: caps,
    suppressionMode: sendProvider ? sendProvider.providerSuppression.mode(caps) : null,
    dkimSelector: domain.dkim_selector,
    probeAddress: domain.probe_token ? probeAddress(domain) : null,
    dnsRecords: domain.dns_records,
    webhooks: { ...webhooks, configured: domain.webhook_events, urls: urls ?? null },
    requiredEvents: events,
    manualSteps: {
      send: steps(send, 'send'),
      receive: steps(receive, 'receive')
    },
    lastCheckedAt: domain.last_checked_at,
    verifiedAt: domain.verified_at,
    createdAt: domain.created_at
  }
}

export async function listMailDomains(scope: MailScope) {
  return await mailAdmin(async (mail) => {
    const domains = await mail.admin.listDomains(scope)
    const accounts = await accountsById(mail, domains.flatMap(d => [d.send_account_id, d.receive_account_id]))
    return { domains: await Promise.all(domains.map(d => domainPayload(mail, d, accounts))) }
  })
}

async function domainResponse(mail: Mail, domain: MailDomainRow, extra: Record<string, unknown> = {}) {
  const accounts = await accountsById(mail, [domain.send_account_id, domain.receive_account_id])
  return { domain: await domainPayload(mail, domain, accounts), ...extra }
}

const domainBody = z.object({
  domain: z.string().min(1).max(253).optional(),
  sendAccountId: z.string().uuid().nullable().optional(),
  receiveAccountId: z.string().uuid().nullable().optional(),
  setupMode: z.enum(['auto', 'manual']).optional(),
  credentials: z.record(z.string(), z.string()).nullable().optional(),
  dkimSelector: z.string().max(100).nullable().optional(),
  fromDomain: z.string().max(253).nullable().optional(),
  makeDefault: z.boolean().optional(),
  confirmWebhooks: z.boolean().optional()
})

export async function createMailDomain(event: H3Event, scope: MailScope, opts: { useHostOrgAccounts?: boolean } = {}) {
  const body = domainBody.parse(await readBody(event))
  if (!body.domain) throw createError({ statusCode: 422, statusMessage: 'Enter a domain' })
  const domainScoped = await domainScope(scope)
  return await mailAdmin(async (mail) => {
    if (opts.useHostOrgAccounts && body.sendAccountId === undefined && body.receiveAccountId === undefined) {
      const host = domainScoped.hostAccounts ?? await hostOrgMailAccounts()
      const rows = await mail.admin.accountsByIds([host.send, host.receive])
      // An env account with no provider still sends under the local transports.
      const supports = (id: string | null, role: 'send' | 'receive') => {
        const row = id ? rows.get(id) : undefined
        if (!row) return false
        if (!row.provider) return role === 'send'
        return !!mail.providers.find(p => p.id === row.provider)?.supports[role]
      }
      body.sendAccountId = supports(host.send, 'send') ? host.send : null
      body.receiveAccountId = body.setupMode !== 'manual' && supports(host.receive, 'receive') ? host.receive : null
    }
    const res = await mail.admin.addDomain(domainScoped, { ...body, domain: body.domain! }, mailBaseUrl())
    return await domainResponse(mail, res.domain, { setup: res.setup })
  })
}

export async function patchMailDomain(event: H3Event, scope: MailScope, id: string) {
  const body = domainBody.parse(await readBody(event))
  const domainScoped = await domainScope(scope)
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.patchDomain(domainScoped, id, body, mailBaseUrl())
    return await domainResponse(mail, res.domain, { setup: res.setup })
  })
}

export async function deleteMailDomain(scope: MailScope, id: string) {
  await mailAdmin(mail => mail.admin.deleteDomain(scope, id))
  return { ok: true }
}

export async function checkMailDomain(scope: MailScope, id: string) {
  return await mailAdmin(async (mail) => {
    const check = await mail.admin.checkDomain(scope, id, mailBaseUrl())
    return await domainResponse(mail, await mail.admin.getDomain(scope, id), { check })
  })
}

export async function verifyMailDomainOwnership(scope: MailScope, id: string) {
  return await mailAdmin(async (mail) => {
    const res = await mail.admin.verifyOwnership(scope, id, mailBaseUrl())
    return await domainResponse(mail, res.domain, { ok: res.ok, setup: res.setup })
  })
}

export async function getMailStreams(scope: MailScope) {
  return await mailAdmin(async (mail) => {
    const overview = await mail.admin.streamsOverview(scope)
    const domains = await mail.admin.listDomains(scope)
    // The host's own sending domain; for an org, where its mail goes out until it has its own.
    const fallback = await mail.resolveSender('system', null).catch(() => null)
    return {
      ...overview,
      fallbackDomain: fallback?.domain ?? null,
      domains: domains.map(d => ({ id: d.id, domain: d.domain, sendStatus: d.send_status, receiveStatus: d.receive_status, ownershipStatus: d.ownership_status, canSend: !!d.send_account_id, canReceive: !!d.receive_account_id }))
    }
  })
}

const streamsBody = z.object({
  routes: z.array(z.object({ stream: z.string().min(1).max(64), domainId: z.string().uuid().nullable() })).max(100)
})

export async function putMailStreams(event: H3Event, scope: MailScope) {
  const body = streamsBody.parse(await readBody(event))
  await mailAdmin(async (mail) => {
    for (const r of body.routes) await mail.admin.setStreamRoute(scope, r.stream, r.domainId, mailBaseUrl())
  })
  return await getMailStreams(scope)
}

const suppressionQuery = z.object({
  reason: z.enum(['hard_bounce', 'complaint']).optional(),
  address: z.string().max(320).optional(),
  includeCleared: z.coerce.boolean().optional()
})

export async function listMailSuppressions(event: H3Event, scope: MailScope) {
  const q = suppressionQuery.parse(getQuery(event))
  return await mailAdmin(async mail => ({
    suppressions: await mail.admin.listSuppressions(scope, { reason: q.reason, address: q.address?.trim() || undefined, includeCleared: q.includeCleared })
  }))
}

export async function clearMailSuppression(event: H3Event, scope: MailScope, id: string) {
  const body = z.object({ address: z.string().max(320).optional() }).parse((await readBody(event).catch(() => ({}))) ?? {})
  return await mailAdmin(async mail => ({ suppression: await mail.admin.clearSuppression(scope, id, body.address) }))
}

export async function sendMailTest(event: H3Event, scope: MailScope) {
  const body = z.object({ stream: z.string().min(1), to: z.string().email() }).parse(await readBody(event))
  return await mailAdmin(async (mail) => {
    const result = await mail.send({
      stream: body.stream,
      orgId: scope.orgId,
      to: body.to,
      subject: 'Test email',
      html: '<p>This is a test email. If you can read it, mail on this stream works.</p>'
    })
    return { result }
  })
}
