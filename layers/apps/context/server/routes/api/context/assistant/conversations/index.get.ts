// GET /api/context/assistant/conversations?portfolio=<slug>&section=<key>
// The caller's conversations for one scope: both params = a section, the
// portfolio alone = that portfolio, neither = the whole workspace.
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../utils/portfolio-helpers'
import { listConversations } from '../../../../../utils/assistant-conversations'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const q = getQuery(event)
    const slug = typeof q.portfolio === 'string' ? q.portfolio.trim() : ''
    const section = typeof q.section === 'string' ? q.section.trim() : ''
    const portfolio = slug ? await getPortfolioBySlugOr404(tx, slug) : null
    const conversations = await listConversations(tx, ctx.userId, {
      portfolioId: portfolio?.id ?? null,
      sectionKey: portfolio && section ? section : null
    })
    return { conversations }
  })
})
