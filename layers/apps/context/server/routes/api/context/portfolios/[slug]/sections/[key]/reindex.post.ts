// POST /api/context/portfolios/:slug/sections/:key/reindex — rebuild one
// section's vector chunks (the "re-embed" button after a failed save-time
// embed). Returns the new index state. The permission check runs in the
// request tx; the embedding runs after it, in short scoped transactions.
import { withOrgPermission } from '#tenant/server'
import { txScopeOf } from '#core/server/utils/after-commit'
import { getPortfolioBySlugOr404 } from '../../../../../../../utils/portfolio-helpers'
import { loadSection, requireKnownSection } from '../../../../../../../utils/section-helpers'
import { indexSectionScoped } from '../../../../../../../utils/section-index'

export default defineEventHandler(async (event) => {
  const target = await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    await requireKnownSection(tx, p.id, key)
    const section = await loadSection(tx, p.id, key)
    return section ? { sectionId: section.id, scope: await txScopeOf(tx) } : null
  })
  if (!target) return { index_state: 'none', index_error: null, chunks: 0 }
  const result = await indexSectionScoped(target.scope, target.sectionId)
  return { index_state: result.state, index_error: result.error, chunks: result.chunks }
})
