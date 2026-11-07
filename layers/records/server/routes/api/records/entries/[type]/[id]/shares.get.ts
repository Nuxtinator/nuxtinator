// GET /api/records/entries/:type/:id/shares
// Everyone this record is shared with, joined with the user directory:
// { items: [{ userId, name, email, avatarUrl, level, grantedBy, createdAt }],
//   via: [{ sourceId, label, path, audience }] } — `via` lists the places
// that share the record besides direct shares (hand-picked views the caller
// can open).
// The caller's share capability lives on the record detail's capabilities
// block; the write routes enforce the permission regardless. Permission: the
// type evaluator's read answer plus the record-visibility rule.

import { withOrgContext } from '#tenant/server'
import { assertRecordVisible, listShares, listShareVia, requireRecordType, requireTypePermission } from '#records/server'

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey, ctx)
    await assertRecordVisible(tx, ctx, typeKey, id)

    return { items: await listShares(tx, id), via: await listShareVia(tx, ctx, typeKey, id) }
  })
})
