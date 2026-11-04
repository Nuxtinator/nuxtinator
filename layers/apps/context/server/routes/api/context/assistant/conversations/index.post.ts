// POST /api/context/assistant/conversations
// Start a conversation in a scope: `{ portfolio?: slug, section?: key }`.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { getPortfolioBySlugOr404 } from '../../../../../utils/portfolio-helpers'
import { isKnownSectionKey } from '../../../../../utils/section-helpers'
import { createConversation } from '../../../../../utils/assistant-conversations'

const Body = z.object({
  portfolio: z.string().min(1).max(64).optional(),
  section: z.string().min(1).max(64).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
    const parsed = Body.safeParse((await readBody(event)) ?? {})
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { portfolio: slug, section } = parsed.data
    if (section && !slug) {
      throw createError({ statusCode: 400, statusMessage: 'A section scope needs a portfolio.' })
    }
    const portfolio = slug ? await getPortfolioBySlugOr404(tx, slug) : null
    if (portfolio && section && !(await isKnownSectionKey(tx, portfolio.id, section))) {
      throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${section}` })
    }
    const conversation = await createConversation(tx, ctx.userId, {
      portfolioId: portfolio?.id ?? null,
      sectionKey: portfolio && section ? section : null
    })
    return { conversation }
  })
})
