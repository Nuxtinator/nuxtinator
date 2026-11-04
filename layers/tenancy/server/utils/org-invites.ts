import type { Transaction } from 'kysely'
import { getRolePermissions } from '#core/server/utils/rbac'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from './tenant'

// Refuses (403) an org-level action on an invite that grants permissions the
// caller doesn't hold in the active org. With `onlyThisOrg`, also refuses an
// invite that grants other orgs or personal apps: only a host admin issues
// those, and reissuing the link would hand over all of them.
export async function assertInviteWithinCaller(
  tx: Transaction<Database>,
  ctx: TenantContext,
  inviteId: string,
  opts: { onlyThisOrg: boolean }
): Promise<void> {
  const orgs = await tx
    .selectFrom('invite_orgs')
    .select(['org_id', 'roles'])
    .where('invite_id', '=', inviteId)
    .execute()

  if (opts.onlyThisOrg) {
    const grantsApps = await tx
      .selectFrom('invite_apps')
      .select('app_id')
      .where('invite_id', '=', inviteId)
      .executeTakeFirst()
    if (orgs.some(o => o.org_id !== ctx.orgId) || grantsApps) {
      throw createError({ statusCode: 403, statusMessage: 'This invite also grants access outside this org; a host admin manages it' })
    }
  }

  const roles = orgs.find(o => o.org_id === ctx.orgId)?.roles ?? []
  const granted = await getRolePermissions(tx, roles, ctx.orgId)
  const missing = [...granted].filter(p => !ctx.perms.has(p))
  if (missing.length > 0) {
    throw createError({
      statusCode: 403,
      statusMessage: `This invite grants permissions you don't hold: ${missing.join(', ')}`
    })
  }
}
