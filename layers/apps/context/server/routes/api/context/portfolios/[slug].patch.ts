// PATCH /api/context/portfolios/:slug — rename / recolor / update icon URL.
import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../utils/portfolio-helpers'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().trim().max(20).nullable().optional(),
  icon_url: z.string().trim().max(2048).nullable().optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.write', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const existing = await getPortfolioBySlugOr404(tx, slug)
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const patch = parsed.data
    if (Object.keys(patch).length === 0) return existing

    const updated = await tx
      .updateTable('context_portfolios')
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.icon_url !== undefined ? { icon_url: patch.icon_url } : {}),
        updated_at: sql<Date>`now()`
      })
      .where('id', '=', existing.id)
      .returning(['id', 'slug', 'name', 'color', 'icon_url', 'template', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow()

    logUpdate('context_portfolios', updated.id, ctx.userId, { patch })

    return updated
  })
})
