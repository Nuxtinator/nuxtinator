// POST /api/context/portfolios — create a portfolio in the active org.
// `template` picks a registered portfolio template (omitted = the default);
// `builtin_sections` picks which of its sections it starts with (omitted =
// all, [] = none). `visibility` + `teamIds` limit it to teams.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { readContainerTeamsInput, setContainerTeams } from '#core/server/utils/team-access'
import { createPortfolio, getContextTeamScope, withContextPortfolioTeams } from '../../../../utils/portfolio-helpers'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  color: z.string().trim().max(20).nullable().optional(),
  slug: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/).optional(),
  template: z.string().min(1).max(64).optional(),
  builtin_sections: z.array(z.string().min(1).max(64)).max(50).optional()
})

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.portfolio.create', async (tx, ctx) => {
    const body = await readBody(event)
    const parsed = Body.safeParse(body)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const teamsInput = readContainerTeamsInput('context_portfolios', body)

    let inserted = await createPortfolio(tx, parsed.data, ctx.userId)
    if (teamsInput) {
      await setContainerTeams(tx, await getContextTeamScope(event, tx, ctx), 'context_portfolios', inserted.id, teamsInput)
      inserted = { ...inserted, visibility: teamsInput.visibility as typeof inserted.visibility }
    }

    logCreate('context_portfolios', inserted.id, ctx.userId, { slug: inserted.slug, name: inserted.name, visibility: inserted.visibility })

    return (await withContextPortfolioTeams(tx, [inserted]))[0]
  })
})
