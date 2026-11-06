// GET /api/records/schema/user-grants?userId=
// One user's direct crm.* permission grants, for the per-user extras panel.
// Returns { items: [{ permission, title, orphan, grantedBy, createdAt }] } —
// orphan flags slugs no longer registered (they stop granting but stay
// revocable). The target must be an active-org member in multi mode (same
// rule as the user directory). Permission: records.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { listRecordsUserGrants, requireGrantTarget } from '#records/server'

const Query = z.object({
  userId: z.string()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'records' }, 'records.schema.manage', async (tx, ctx) => {
    const parsed = Query.safeParse(getQuery(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid query', data: parsed.error.flatten() })
    }
    await requireGrantTarget(tx, ctx, parsed.data.userId)
    return { items: await listRecordsUserGrants(tx, parsed.data.userId) }
  })
})
