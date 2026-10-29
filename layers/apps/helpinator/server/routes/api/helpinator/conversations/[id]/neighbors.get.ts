// GET /api/helpinator/conversations/:id/neighbors — the newer (prevId) and
// older (nextId) conversation either side of this one in the log.
// Query: the list's filters — widgetId, handedOff=true|false, hasEmail=true.
import { withOrgPermission } from '#tenant/server'
import { helpinatorConversationNeighbors, helpinatorGetConversationOr404 } from '../../../../../utils/helpinator-admin'

function bool(v: unknown): boolean | undefined {
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.access', async (tx) => {
    const conversation = await helpinatorGetConversationOr404(tx, getRouterParam(event, 'id') ?? '')
    return await helpinatorConversationNeighbors(tx, conversation.id, {
      widgetId: typeof q.widgetId === 'string' ? q.widgetId : undefined,
      handedOff: bool(q.handedOff),
      hasEmail: bool(q.hasEmail)
    })
  })
})
