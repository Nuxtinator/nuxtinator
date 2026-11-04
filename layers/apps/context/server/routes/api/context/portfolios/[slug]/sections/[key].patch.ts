// PATCH /api/context/portfolios/:slug/sections/:key — update a section
// definition's title/description/order. Key is immutable once created. On a
// built-in row the stored values override the template defaults.
import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { getPortfolioBySlugOr404 } from '../../../../../../utils/portfolio-helpers'
import { getPortfolioSections } from '../../../../../../utils/section-settings'

const Body = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  order: z.number().int().min(0).optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'context' }, 'context.section.custom', async (tx, ctx) => {
    const slug = getRouterParam(event, 'slug') ?? ''
    const key = getRouterParam(event, 'key') ?? ''
    const p = await getPortfolioBySlugOr404(tx, slug)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const patch = parsed.data
    if (Object.keys(patch).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update.' })
    }

    const existing = await tx
      .selectFrom('context_section_definitions')
      .select('id')
      .where('portfolio_id', '=', p.id)
      .where('key', '=', key)
      .executeTakeFirst()
    if (!existing) throw createError({ statusCode: 404, statusMessage: `Unknown section key: ${key}` })

    await tx
      .updateTable('context_section_definitions')
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.order !== undefined ? { order: patch.order } : {}),
        updated_at: sql<Date>`now()`
      })
      .where('id', '=', existing.id)
      .execute()

    logUpdate('context_section_definitions', existing.id, ctx.userId, {
      portfolio_id: p.id, key, patch
    })

    const sections = await getPortfolioSections(tx, p)
    return sections.find(s => s.key === key)
  })
})
