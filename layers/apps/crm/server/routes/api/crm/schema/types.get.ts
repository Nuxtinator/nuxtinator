// GET /api/crm/schema/types
// Merged record-type catalog (code manifests ⊳ DB overrides). Returns
// { types: [{ key, label, labelSingular, icon, hidden, custom, orphan,
//   statusField, closedReasonField, canRead, canCreate }] }. canRead/canCreate are the caller's
// type-evaluator answers — per-type role-grant rows make client-side slug
// checks unreliable, so the server is the only truthful source. Hidden,
// stale (orphan), and non-readable entries only appear for schema managers —
// the schema builder needs them; navigation does not. Permission: crm.access.

import { withOrgPermission } from '#tenant/server'
import { getRecordTypes, resolveTypeCapabilities } from '#crm/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'crm' }, 'crm.access', async (tx, ctx) => {
    const canManage = ctx.perms.has('crm.schema.manage')
    const types = await getRecordTypes(tx)
    const out = []
    // Sequential evaluation — queries on one transaction connection must not
    // interleave; the evaluator memoizes its lookups per request, so per-type
    // cost after the first is just the roleGrants map.
    for (const t of types) {
      const caps = await resolveTypeCapabilities(tx, ctx, t.key)
      if (!canManage && (t.hidden || t.orphan || !caps.read)) continue
      out.push({
        key: t.key,
        label: t.label,
        labelSingular: t.labelSingular,
        icon: t.icon ?? null,
        hidden: t.hidden,
        custom: t.custom,
        orphan: t.orphan,
        statusField: t.statusField ?? null,
        closedReasonField: t.closedReasonField ?? null,
        canRead: caps.read,
        canCreate: caps.create
      })
    }
    return { types: out }
  })
})
