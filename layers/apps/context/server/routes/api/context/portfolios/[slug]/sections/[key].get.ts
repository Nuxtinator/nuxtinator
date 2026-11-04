// GET /api/context/portfolios/:slug/sections/:key — read one section.
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { loadSection, isKnownSectionKey } from '../../../../../../utils/section-helpers'
import { getPortfolioSections } from '../../../../../../utils/section-settings'
import { sectionIndexAvailable } from '../../../../../../utils/section-index'
import { isEmbeddingConfigured } from '#ai/server'
import { pendingForSection, REVIEW_PERMISSION } from '../../../../../../utils/suggestions'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const known = await isKnownSectionKey(tx, p.id, key)
    if (!known) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })

    const section = await loadSection(tx, p.id, key)
    const defs = await getPortfolioSections(tx, p)
    const def = defs.find(d => d.key === key)
    // Content that predates embeddings (or a failed first index that was
    // never retried) has no chunks: say so, so the re-embed button shows.
    let indexState: 'none' | 'ok' | 'stale' | 'unindexed' = section?.index_state ?? 'none'
    if (indexState === 'none' && section?.content && (await sectionIndexAvailable()) && (await isEmbeddingConfigured(tx))) {
      const chunk = await tx.selectFrom('context_section_chunks').select('id').where('section_id', '=', section.id).limit(1).executeTakeFirst()
      if (!chunk) indexState = 'unindexed'
    }

    return {
      portfolio_id: p.id,
      key,
      title: def?.title ?? key,
      description: def?.description ?? '',
      is_custom: def?.is_custom ?? false,
      content: section?.content ?? '',
      last_edited_at: section?.last_edited_at ?? null,
      last_edited_by: section?.last_edited_by ?? null,
      index_state: indexState,
      index_error: section?.index_error ?? null,
      pending_suggestions: await pendingForSection(tx, p.id, key, {
        userId: ctx.userId,
        isReviewer: ctx.perms.has(REVIEW_PERMISSION)
      })
    }
  })
})
