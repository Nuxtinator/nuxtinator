// PUT /api/crm/schema/types/:type/role-grants
// Full replacement of the type's per-role action grants (config.roleGrants).
// Only explicit true/false entries persist — an absent (role, action) pair
// means "inherit from the role's slugs". Role keys must name real roles
// (static or custom; updateTypeRoleGrants only shape-checks), and 'admin' is
// rejected outright: admins bypass the matrix, so a stored admin row would
// be dead weight that misleads the next reader. A true entry the type doesn't
// already store needs the caller to have that action on the type themselves.
// Returns the refreshed GET shape. Permission: crm.schema.manage.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { validateRoleNames } from '#core/server/utils/rbac'
import { buildRoleGrantsView, CRM_RECORD_ACTIONS, getRecordType, resolveTypePermission, updateTypeRoleGrants } from '#crm/server'
import type { CrmRecordAction } from '#crm/server'

// Action names and per-role shapes are validated by updateTypeRoleGrants
// (with per-entry error messages); zod only pins the outer contract.
const Body = z.object({
  grants: z.record(z.string(), z.record(z.string(), z.boolean()))
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.schema.manage', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const roleKeys = Object.keys(parsed.data.grants)
    if (roleKeys.includes('admin')) {
      throw createError({ statusCode: 400, statusMessage: 'The admin role always has full access and cannot carry grants' })
    }
    const { valid, unknown } = await validateRoleNames(tx, roleKeys)
    if (!valid) {
      throw createError({ statusCode: 400, statusMessage: `Unknown role(s): ${unknown.join(', ')}` })
    }

    // Unknown types and actions are left to updateTypeRoleGrants' 404 / 400.
    const existing = await getRecordType(tx, typeKey)
    const newlyGranted = new Set<CrmRecordAction>()
    if (existing && !existing.orphan) {
      const stored = existing.roleGrants
      for (const [role, actions] of Object.entries(parsed.data.grants)) {
        for (const action of CRM_RECORD_ACTIONS) {
          if (actions[action] === true && stored[role]?.[action] !== true) newlyGranted.add(action)
        }
      }
    }
    const missing: string[] = []
    for (const action of newlyGranted) {
      if (!(await resolveTypePermission(tx, ctx, typeKey, action))) missing.push(action)
    }
    if (missing.length > 0) {
      throw createError({ statusCode: 403, statusMessage: `Cannot grant actions you don't hold on ${typeKey}: ${missing.join(', ')}` })
    }

    const type = await updateTypeRoleGrants(tx, ctx, typeKey, parsed.data.grants)
    return await buildRoleGrantsView(tx, ctx, type)
  })
})
