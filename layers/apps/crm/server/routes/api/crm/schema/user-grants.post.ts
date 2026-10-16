// POST /api/crm/schema/user-grants
// Grants one crm.* permission directly to a user. Grants are slug-level and
// additive — they ride on top of role perms and pass through the type
// evaluator untouched, so a role-keyed per-type deny can never subtract
// them. The slug must be crm.*-prefixed and registered (core's grant service
// 400s unknown slugs); granting an already-held permission is a no-op. The
// caller can only grant permissions they hold themselves.
// Returns the refreshed grants list. Permission: crm.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { grantUserPermission } from '#core/server/utils/permission-grants'
import { isRegisteredPermission } from '#core/server/utils/permissions-registry'
import { assertCrmPermissionSlug, listCrmUserGrants, requireGrantTarget } from '#crm/server'

const Body = z.object({
  userId: z.string(),
  permission: z.string().trim().min(1).max(120)
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    assertCrmPermissionSlug(parsed.data.permission)
    if (isRegisteredPermission(parsed.data.permission) && !ctx.perms.has(parsed.data.permission as never)) {
      throw createError({ statusCode: 403, statusMessage: `Cannot grant permissions you don't hold: ${parsed.data.permission}` })
    }
    await requireGrantTarget(tx, ctx, parsed.data.userId)
    await grantUserPermission(tx, ctx, parsed.data.userId, parsed.data.permission)
    return { items: await listCrmUserGrants(tx, parsed.data.userId) }
  })
})
