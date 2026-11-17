// The org side of the mail kernel: the org settings section, who gets an
// org's mail alerts, and deprovisioning an org's domains when it's deleted
// (the rows themselves go with the org by cascade).
import { sql } from 'kysely'
import { registerOrgSettingsSection } from '#core/server/utils/org-settings-section-registry'
import { mailIfBuilt } from '#core/server/utils/mail'
import { setMailOrgAdminResolver } from '#core/server/utils/mail-host'
import { adminDb } from '../utils/database-admin'

export default defineNitroPlugin((nitroApp) => {
  registerOrgSettingsSection({
    appId: 'tenancy',
    title: 'Email',
    path: 'email',
    icon: 'i-lucide-mail',
    requiredPermission: 'org.mail.manage',
    order: 50
  })

  setMailOrgAdminResolver(async (orgId) => {
    const rows = await sql<{ email: string }>`
      select u.email from memberships m join users u on u.id = m.user_id
      where m.org_id = ${orgId} and 'admin' = any(m.roles) and u.email is not null
    `.execute(adminDb)
    return rows.rows.map(r => r.email)
  })

  nitroApp.hooks.hook('org.deleted', async ({ orgId }: { orgId: string }) => {
    const mail = mailIfBuilt()
    if (!mail) return
    for (const domain of await mail.admin.listDomains({ orgId })) {
      await mail.admin.deprovision(domain).catch(err => console.warn('[mail] deprovision failed:', err))
    }
  })
})
