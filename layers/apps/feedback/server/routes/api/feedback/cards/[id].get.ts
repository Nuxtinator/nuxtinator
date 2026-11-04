import { getRouterParam } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { assertFeedbackCardAccess, getFeedbackTeamScope } from '../../../../utils/project-teams'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
    await assertFeedbackCardAccess(tx, await getFeedbackTeamScope(event, tx, ctx), id)

    const card = await tx
      .selectFrom('cards')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()

    if (!card) throw createError({ statusCode: 404, statusMessage: 'Card not found' })
    return card
  })
})
