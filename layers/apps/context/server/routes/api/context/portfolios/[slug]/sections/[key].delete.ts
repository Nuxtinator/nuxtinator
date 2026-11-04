// DELETE /api/context/portfolios/:slug/sections/:key — remove a section
// definition, built-in or custom. Content saved under the key stays in
// `context_sections` and resurfaces if the section is added again.
import { withOrgPermission } from '#tenant/server'
import { logDelete } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { deleteSection } from '../../../../../../utils/section-helpers'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.section.custom', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const deleted = await deleteSection(tx, p.id, key)

    logDelete('context_section_definitions', deleted.id, ctx.userId, {
      portfolio_id: p.id, key
    })

    return { ok: true, key, ...deleted }
  })
})
