// Shapes and fetchers for the mail admin pages. `host` reads /api/admin/mail,
// `org` reads /api/o/<slug>/mail; both share these components.
import type { MaybeRefOrGetter } from 'vue'

export type MailScope = 'host' | 'org'
export type MailCapabilityKey = 'send' | 'domains' | 'routes' | 'webhooks' | 'suppressionLists'
export type MailCapabilities = Partial<Record<MailCapabilityKey, boolean>>
export type MailRoleStatus = 'pending' | 'verified' | 'failed'

export interface MailCredentialField {
  key: string
  label: string
  secret: boolean
  optional?: boolean
  help?: string
  forWebhooks?: boolean
  advanced?: boolean
}

export interface MailProviderInfo {
  id: string
  label: string
  credentialFields: MailCredentialField[]
  domainCredentialFields: MailCredentialField[]
  supports: { send: boolean, receive: boolean, events: boolean }
  webhookScope: 'domain' | 'account'
  notes: { send?: string, receive?: string }
}

export interface MailWebhookUrls {
  events: string
  inbound: string
  inboundMime: string
}

export interface MailAccount {
  id: string
  orgId: string | null
  source: 'ui' | 'env'
  provider: string | null
  providerLabel: string | null
  label: string
  credentials: Record<string, string>
  hasKey: boolean
  capabilities: MailCapabilities
  webhookTokenVersion: number
  createdAt: string
  webhookUrls: MailWebhookUrls | null
  // Set on an org's own account when the host lists it
  orgName?: string | null
}

export interface MailAccountsResponse {
  accounts: MailAccount[]
  // Every org's own accounts; host scope only
  orgAccounts: MailAccount[]
  // The host's account an org may receive through; org scope only
  hostReceiveAccount: { id: string, provider: string } | null
  providers: MailProviderInfo[]
  outboxPublicKey: string | null
  transport: string
}

export type MailVerifyResult = { ok: true, capabilities: MailCapabilities } | { ok: false, error: string } | null

export interface MailDnsRecord {
  role: 'send' | 'receive' | 'ownership'
  type: 'TXT' | 'CNAME' | 'MX'
  name: string
  value: string
  priority?: number
  status?: MailRoleStatus
  purpose?: string
}

export interface MailManualStep {
  title: string
  detail?: string
  values?: { label: string, value: string }[]
  // Key of the check that confirms the step
  check?: string
}

export interface MailDomain {
  id: string
  orgId: string | null
  source: 'ui' | 'env'
  domain: string
  fromDomain: string | null
  ownershipStatus: 'pending' | 'verified' | 'lapsed'
  ownershipRecord: { type: 'TXT', name: string, value: string } | null
  setupMode: 'auto' | 'manual'
  roleModes: { send: 'auto' | 'manual', receive: 'auto' | 'manual' }
  canAutoSetup: boolean
  sendAccountId: string | null
  receiveAccountId: string | null
  sendProvider: { id: string | null, label: string } | null
  receiveProvider: { id: string, label: string } | null
  sendStatus: MailRoleStatus
  receiveStatus: MailRoleStatus
  sendError: string | null
  hasOwnCredentials: boolean
  // The key the domain sends with, masked; null when it has none
  key: { source: 'domain' | 'account', label: string, value: string, accountLabel?: string | null } | null
  capabilities: MailCapabilities
  suppressionMode: 'disabled' | 'mirrored' | 'unmanaged' | null
  dkimSelector: string | null
  probeAddress: string | null
  dnsRecords: MailDnsRecord[]
  webhooks: { state: 'connected' | 'needs_update' | 'not_configured', required: string[], configured: string[] | null, urls: MailWebhookUrls | null }
  requiredEvents: string[]
  manualSteps: { send: MailManualStep[], receive: MailManualStep[] }
  lastCheckedAt: string | null
  verifiedAt: string | null
  createdAt: string
}

export interface MailDomainSetup {
  mxConflict: string[]
  roles: { role: 'send' | 'receive', mode: 'auto' | 'manual', error?: string }[]
}

export interface MailRoleCheck {
  role: 'send' | 'receive'
  status: MailRoleStatus
  checks: { key: string, label: string, ok: boolean | null, detail?: string }[]
  error?: string
}

export interface MailDomainCheck {
  ownership?: { ok: boolean, record: { name: string, value: string } }
  roles: MailRoleCheck[]
  webhooks?: { ok: boolean, error?: string }
  setup?: MailDomainSetup | null
}

export interface MailDomainResponse {
  domain: MailDomain
  setup?: MailDomainSetup | null
  check?: MailDomainCheck
  ok?: boolean
}

export interface MailStreamOverview {
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

export interface MailStreamsResponse {
  defaultDomainId: string | null
  streams: MailStreamOverview[]
  fallbackDomain: string | null
  domains: { id: string, domain: string, sendStatus: MailRoleStatus, receiveStatus: MailRoleStatus, ownershipStatus: string, canSend: boolean, canReceive: boolean }[]
}

export interface MailSuppression {
  id: string
  reason: 'hard_bounce' | 'complaint'
  scope: 'global' | 'host' | 'org'
  orgId: string | null
  source: string | null
  detail: string | null
  occurredAt: string
  createdAt: string
  clearedAt: string | null
  clearedReason: string | null
  address?: string
}

export type MailSendResult
  = | { status: 'sent', accountId: string, domain: string, providerMessageId: string | null, messageId: string | null }
    | { status: 'suppressed', reason: 'hard_bounce' | 'complaint' }
    | { status: 'refused', guard: string, reason: string }
    | { status: 'no_sender', stream: string }
    | { status: 'failed', retryable: boolean, error: string }
    | { status: 'unknown', error: string }
    | { status: 'queued', outboxId: string }

export const MAIL_CAPABILITY_LABELS: Record<MailCapabilityKey, string> = {
  send: 'Sending',
  domains: 'Domains',
  routes: 'Routes',
  webhooks: 'Webhooks',
  suppressionLists: 'Suppression lists'
}

export const MAIL_ROLE_STATUS: Record<MailRoleStatus, { label: string, color: 'warning' | 'success' | 'error' }> = {
  pending: { label: 'Pending', color: 'warning' },
  verified: { label: 'Verified', color: 'success' },
  failed: { label: 'Failed', color: 'error' }
}

export const MAIL_SUPPRESSION_REASONS: Record<MailSuppression['reason'], string> = {
  hard_bounce: 'Hard bounce',
  complaint: 'Complaint'
}

export const MAIL_SUPPRESSION_SCOPES: Record<MailSuppression['scope'], string> = {
  global: 'Everywhere',
  host: 'Host mail',
  org: 'One organization'
}

export const MAIL_WEBHOOK_STATES: Record<MailDomain['webhooks']['state'], { label: string, color: 'success' | 'warning' | 'neutral' }> = {
  connected: { label: 'Connected', color: 'success' },
  needs_update: { label: 'Need updating', color: 'warning' },
  not_configured: { label: 'Not set up', color: 'neutral' }
}

export function mailErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const e = err as { data?: { statusMessage?: string, message?: string }, statusMessage?: string } | null
  return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || fallback
}

export function mailApiBase(scope: MailScope, orgSlug?: string | null): string {
  return scope === 'host' ? '/api/admin/mail' : `/api/o/${orgSlug}/mail`
}

export function mailDataKey(scope: MailScope, name: 'accounts' | 'domains' | 'streams' | 'suppressions'): string {
  return scope === 'host' ? `mail-${name}` : `org-mail-${name}`
}

export async function refreshMail(scope: MailScope, ...names: ('accounts' | 'domains' | 'streams' | 'suppressions')[]) {
  await refreshNuxtData(names.map(n => mailDataKey(scope, n)))
}

export function useMailAccounts(scope: MailScope, orgSlug?: MaybeRefOrGetter<string | null | undefined>) {
  return useAsyncData<MailAccountsResponse>(
    mailDataKey(scope, 'accounts'),
    () => $fetch<MailAccountsResponse>(`${mailApiBase(scope, toValue(orgSlug))}/accounts`),
    { default: () => ({ accounts: [], orgAccounts: [], hostReceiveAccount: null, providers: [], outboxPublicKey: null, transport: '' }), watch: orgSlug ? [() => toValue(orgSlug)] : undefined }
  )
}

export function useMailDomains(scope: MailScope, orgSlug?: MaybeRefOrGetter<string | null | undefined>) {
  return useAsyncData<{ domains: MailDomain[] }>(
    mailDataKey(scope, 'domains'),
    () => $fetch<{ domains: MailDomain[] }>(`${mailApiBase(scope, toValue(orgSlug))}/domains`),
    { default: () => ({ domains: [] }), watch: orgSlug ? [() => toValue(orgSlug)] : undefined }
  )
}

export function useMailStreams(scope: MailScope, orgSlug?: MaybeRefOrGetter<string | null | undefined>) {
  return useAsyncData<MailStreamsResponse>(
    mailDataKey(scope, 'streams'),
    () => $fetch<MailStreamsResponse>(`${mailApiBase(scope, toValue(orgSlug))}/streams`),
    { default: () => ({ defaultDomainId: null, streams: [], fallbackDomain: null, domains: [] }), watch: orgSlug ? [() => toValue(orgSlug)] : undefined }
  )
}

export function useMailCopy() {
  const toast = useToast()
  return async (value: string, label = 'Copied') => {
    try {
      await navigator.clipboard.writeText(value)
      toast.add({ title: label, color: 'success' })
    } catch {
      toast.add({ title: 'Copy failed: select the text and copy it', color: 'warning' })
    }
  }
}

export function formatMailDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
