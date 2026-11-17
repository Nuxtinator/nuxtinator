import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupTenancyTestData,
  createOperatorAdmin,
  createTestOrg
} from '../helpers'

describe('GET /api/admin/mail/accounts (org-owned accounts)', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await sql`DELETE FROM mail_accounts WHERE label LIKE 'test-tenancy-%'`
    await cleanupTenancyTestData(sql)
  })

  it('lists every org\'s own accounts apart from the host\'s, named by org, with no webhook URLs', async () => {
    const { auth } = await createOperatorAdmin(sql)
    const org = await createTestOrg(sql, { name: 'Mail Owner Org' })
    await sql`INSERT INTO mail_accounts (org_id, provider, label, capabilities) VALUES (${org.id}, 'mailgun', 'test-tenancy-org-acct', '{}')`
    await sql`INSERT INTO mail_accounts (org_id, provider, label, capabilities) VALUES (NULL, 'mailgun', 'test-tenancy-host-acct', '{}')`

    const res = await $fetch('/api/admin/mail/accounts', auth) as {
      accounts: { label: string }[]
      orgAccounts: { label: string, orgId: string, orgName: string | null, webhookUrls: unknown }[]
    }
    expect(res.accounts.map(a => a.label)).toContain('test-tenancy-host-acct')
    expect(res.accounts.map(a => a.label)).not.toContain('test-tenancy-org-acct')
    const own = res.orgAccounts.find(a => a.label === 'test-tenancy-org-acct')
    expect(own).toMatchObject({ orgId: org.id, orgName: 'Mail Owner Org', webhookUrls: null })
    expect(res.orgAccounts.map(a => a.label)).not.toContain('test-tenancy-host-acct')
  })
})
