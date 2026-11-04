// GET /api/context/portfolios/:slug/sections/:key/export — single section .md.
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../../../utils/portfolio-helpers'
import { isKnownSectionKey, loadSection } from '../../../../../../../utils/section-helpers'
import { getPortfolioSections } from '../../../../../../../utils/section-settings'
import { formatSectionMarkdown } from '../../../../../../../utils/export'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.read', async (tx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)
    const known = await isKnownSectionKey(tx, p.id, key)
    if (!known) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })

    const defs = await getPortfolioSections(tx, p)
    const def = defs.find(d => d.key === key)
    const section = await loadSection(tx, p.id, key)
    const md = formatSectionMarkdown(def?.title ?? key, section?.content ?? '')

    setHeader(event, 'Content-Type', 'text/markdown')
    setHeader(event, 'Content-Disposition', `attachment; filename="${key}.md"`)
    return md
  })
})
