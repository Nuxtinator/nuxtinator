// GET /api/helpinator/conversations — the read-only log, newest first.
// Query: widgetId, handedOff=true|false, hasEmail=true, limit (≤100), offset.
import { withOrgPermission } from '#tenant/server'
import { helpinatorListConversations } from '../../../../utils/helpinator-admin'

function bool(v: unknown): boolean | undefined {
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.access', async (tx) => {
    return await helpinatorListConversations(tx, {
      widgetId: typeof q.widgetId === 'string' ? q.widgetId : undefined,
      handedOff: bool(q.handedOff),
      hasEmail: bool(q.hasEmail),
      limit: Math.min(100, Math.max(1, Number(q.limit) || 50)),
      offset: Math.max(0, Number(q.offset) || 0)
    })
  })
})
