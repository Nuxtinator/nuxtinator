// PATCH /api/context/portfolios/:slug — rename / recolor / update icon URL,
// and `visibility` + `teamIds` to change who can see it.
import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { readContainerTeamsInput, setContainerTeams } from '#core/server/utils/team-access'
import { getContextTeamScope, getPortfolioBySlugOr404, PORTFOLIO_COLUMNS, withContextPortfolioTeams } from '../../../../utils/portfolio-helpers'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().trim().max(20).nullable().optional(),
  icon_url: z.string().trim().max(2048).nullable().optional(),
  visibility: z.unknown().optional(),
  teamIds: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const scope = await getContextTeamScope(event, tx, ctx)
    const existing = await getPortfolioBySlugOr404(tx, slug, scope)
    const body = await readBody(event)
    const parsed = Body.safeParse(body)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { visibility: _visibility, teamIds: _teamIds, ...patch } = parsed.data
    const teamsInput = readContainerTeamsInput('context_portfolios', body)

    let updated = existing
    if (Object.keys(patch).length > 0) {
      updated = await tx
        .updateTable('context_portfolios')
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.color !== undefined ? { color: patch.color } : {}),
          ...(patch.icon_url !== undefined ? { icon_url: patch.icon_url } : {}),
          updated_at: sql<Date>`now()`
        })
        .where('id', '=', existing.id)
        .returning(PORTFOLIO_COLUMNS)
        .executeTakeFirstOrThrow()
      logUpdate('context_portfolios', updated.id, ctx.userId, { patch })
    }

    if (teamsInput) {
      await setContainerTeams(tx, scope, 'context_portfolios', existing.id, teamsInput)
      updated = { ...updated, visibility: teamsInput.visibility as typeof updated.visibility }
      logUpdate('context_portfolios', updated.id, ctx.userId, { visibility: teamsInput.visibility, teamIds: teamsInput.teamIds })
    }

    return (await withContextPortfolioTeams(tx, [updated]))[0]
  })
})
