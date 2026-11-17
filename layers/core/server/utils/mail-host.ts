// Host-side glue for the mail kernel: error mapping for the admin routes,
// alerts from the daily job, and the test-only fake provider state.
import type { H3Event } from 'h3'
import { MailAdminError, type MailAlert, type DnsLookup } from '@nuxtinator/mail/kernel'
import type { FakeProvider } from '@nuxtinator/mail/test'
import { db } from './database'
import { sendMail, useMail, type Mail } from './mail'
import { getSiteUrl } from './site-url'
import { getHostSetting } from './settings-store'

export const MAIL_SETTINGS_NAMESPACE = 'core'
export const SETTING_MAIL_ORG_SEND_ACCOUNT = 'mail_org_send_account'
export const SETTING_MAIL_ORG_RECEIVE_ACCOUNT = 'mail_org_receive_account'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseAccountId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}

// The host accounts an org's custom domain is provisioned on: the two host
// settings, else the env account.
export async function hostOrgMailAccounts(): Promise<{ send: string | null, receive: string | null }> {
  const env = await db.selectFrom('mail_accounts').select('id').where('source', '=', 'env').executeTakeFirst()
  const send = await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_SEND_ACCOUNT)
  const receive = await getHostSetting<string | null>(db, MAIL_SETTINGS_NAMESPACE, SETTING_MAIL_ORG_RECEIVE_ACCOUNT)
  return { send: send ?? env?.id ?? null, receive: receive ?? env?.id ?? null }
}

// Set when MAIL_FAKE_PROVIDER=1 (tests only).
export const mailFakeState: { provider: FakeProvider | null, dns: (DnsLookup & { records: Map<string, { txt?: string[], mx?: { exchange: string, priority: number }[], cname?: string[] }> }) | null } = {
  provider: null,
  dns: null
}

// Runs a kernel admin call, turning its refusals into HTTP errors.
export async function mailAdmin<T>(fn: (mail: Mail) => Promise<T>): Promise<T> {
  const mail = await useMail()
  try {
    return await fn(mail)
  } catch (err) {
    if (err instanceof MailAdminError) {
      throw createError({ statusCode: err.statusCode, statusMessage: err.message, data: err.data })
    }
    throw err
  }
}

export function mailBaseUrl(): string {
  return getSiteUrl()
}

export function requireMailFakeProvider(_event?: H3Event): FakeProvider {
  if (process.env.MAIL_FAKE_PROVIDER !== '1' || !mailFakeState.provider) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  return mailFakeState.provider
}

type OrgAdminEmails = (orgId: string) => Promise<string[]>
let orgAdminEmails: OrgAdminEmails | null = null

// The tenancy layer tells core how to reach an org's admins.
export function setMailOrgAdminResolver(fn: OrgAdminEmails): void {
  orgAdminEmails = fn
}

async function hostAdminEmails(): Promise<string[]> {
  const rows = await db.selectFrom('users').select('email').where('is_admin', '=', true).where('email', 'is not', null).execute()
  return rows.map(r => r.email!).filter(Boolean)
}

function alertText(alert: MailAlert): { subject: string, body: string } {
  if (alert.kind === 'ownership_lapsed') {
    return {
      subject: `We can no longer confirm you control ${alert.domain}`,
      body: `The DNS record that proves you control ${alert.domain} is missing. Your mail is going out from the host's domain until the record is back. Open your organization's email settings and choose "Check now" once it is.`
    }
  }
  return {
    subject: `${alert.domain} can no longer ${alert.role === 'receive' ? 'receive' : 'send'} mail`,
    body: `The daily check found that ${alert.domain} stopped passing its ${alert.role === 'receive' ? 'receiving' : 'sending'} check. ${alert.orgId ? 'Open the email settings of the organization that uses it' : 'Open Admin → Email → Domains'} to see what changed.`
  }
}

// A lapsed claim goes to the org's admins. A lost role goes to the host's
// admins, and also to the org's admins when the domain is an org's.
export async function notifyMailAlert(alert: MailAlert): Promise<void> {
  const org = alert.orgId && orgAdminEmails ? await orgAdminEmails(alert.orgId) : []
  const host = alert.kind === 'role_lost' || !alert.orgId ? await hostAdminEmails() : []
  const { subject, body } = alertText(alert)
  const sent = new Set<string>()
  const send = async (recipients: string[], link: string) => {
    for (const to of recipients) {
      if (sent.has(to)) continue
      sent.add(to)
      await sendMail({
        stream: 'system',
        to,
        subject,
        html: `<p>${body}</p><p><a href="${link}">${link}</a></p>`
      }).catch(err => console.error('[mail] alert send failed:', err))
    }
  }
  await send(host, `${getSiteUrl()}${alert.orgId ? '/admin/orgs' : '/admin/email?tab=domains'}`)
  await send(org, getSiteUrl())
}
