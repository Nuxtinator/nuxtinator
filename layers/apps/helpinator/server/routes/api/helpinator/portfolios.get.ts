// GET /api/helpinator/portfolios — the widget form's portfolio + section picker.
import { withOrgPermission } from '#tenant/server'
import { helpinatorListSections } from '../../../utils/helpinator-bot'
import { helpinatorAssertContextRead } from '../../../utils/helpinator-libraries'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'helpinator' }, 'helpinator.manage', async (tx, ctx) => {
    helpinatorAssertContextRead(ctx)
    const portfolios = await tx
      .selectFrom('context_portfolios')
      .select(['id', 'slug', 'name'])
      .orderBy('order', ob => ob.asc().nullsLast())
      .orderBy('name')
      .execute()
    return await Promise.all(portfolios.map(async p => ({
      ...p,
      sections: await helpinatorListSections(tx, p.id)
    })))
  })
})
