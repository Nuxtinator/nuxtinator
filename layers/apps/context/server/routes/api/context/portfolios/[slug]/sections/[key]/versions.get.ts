// GET /api/context/portfolios/:slug/sections/:key/versions — list versions DESC.
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    if (!section) return { versions: [] }

    const rows = await tx
      .selectFrom('context_section_versions as v')
      .leftJoin('users as u', 'u.id', 'v.edited_by')
      .select([
        'v.id',
        'v.content',
        'v.edited_at',
        'v.edited_by',
        'v.source',
        'u.display_name as edited_by_name'
      ])
      .where('v.section_id', '=', section.id)
      .orderBy('v.edited_at', 'desc')
      .execute()

    return { versions: rows }
  })
})
