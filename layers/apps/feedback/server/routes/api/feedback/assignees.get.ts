// GET /api/feedback/assignees
// Lists users assignable to feedback cards. In multi-tenant mode that is the
// members of the active org; in single-tenant mode it is all users.

import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
    if (ctx.orgId) {
      const rows = await tx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['users.id', 'users.display_name'])
        .where('memberships.org_id', '=', ctx.orgId)
        .orderBy('users.display_name', 'asc')
        .execute()
      return { users: rows.map(r => ({ id: r.id, display_name: r.display_name })) }
    }

    const rows = await tx
      .selectFrom('users')
      .select(['id', 'display_name'])
      .orderBy('display_name', 'asc')
      .execute()
    return { users: rows.map(r => ({ id: r.id, display_name: r.display_name })) }
  })
})
