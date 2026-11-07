// PATCH /api/views/:id — partial update. name/icon need 'edit'. Who can
// open the view (visibility, `teamIds` and `teamLevels` for 'teams',
// `orgLevel` for 'org') and its definition (the base filter, which decides
// what a view of every matching record shows) are the owner's call.
// Whether a view holds hand-picked records and its record type are fixed at
// creation — converting a view is a create-new operation.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { sql } from 'kysely'
import { getTeamScope, setContainerTeams } from '#core/server/utils/team-access'
import { loadViewDetail, requireView, sanitizeViewDefinition, setViewLevels, type ViewDefinition } from '../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().max(64).nullable().optional(),
  visibility: z.enum(['private', 'org', 'teams']).optional(),
  teamIds: z.array(z.string().uuid()).max(100).optional(),
  teamLevels: z.record(z.string().uuid(), z.enum(['view', 'edit'])).optional(),
  orgLevel: z.enum(['view', 'edit']).optional(),
  definition: z.object({ filter: z.unknown().optional() }).strict().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data
    if ((body.teamIds !== undefined || body.teamLevels !== undefined || body.orgLevel !== undefined) && body.visibility === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'teamIds, teamLevels and orgLevel go with visibility' })
    }

    const needed = body.visibility !== undefined || body.definition !== undefined ? 'owner' : 'edit'
    const { view, access, viaShare } = await requireView(tx, ctx, viewId, needed)

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.icon !== undefined) patch.icon = body.icon
    if (body.definition !== undefined) {
      const current = view.definition as ViewDefinition
      const definition = await sanitizeViewDefinition(tx, view.record_type_key, {
        ...body.definition,
        ...(current.picked ? { picked: true } : {})
      })
      // jsonb params bind reliably only through the text cast.
      patch.definition = sql`${JSON.stringify(definition)}::text::jsonb`
    }
    if (body.visibility !== undefined) {
      const scope = await getTeamScope(event, tx, ctx, 'views')
      await setContainerTeams(tx, scope, 'views_definitions', viewId, {
        visibility: body.visibility,
        teamIds: [...new Set(body.teamIds ?? [])]
      })
      await setViewLevels(tx, viewId, { visibility: body.visibility, orgLevel: body.orgLevel, teamLevels: body.teamLevels })
    }
    if (Object.keys(patch).length === 0 && body.visibility === undefined) {
      throw createError({ statusCode: 400, statusMessage: 'Empty patch' })
    }
    patch.updated_at = sql`now()`

    const updated = await tx
      .updateTable('views_definitions')
      .set(patch)
      .where('id', '=', viewId)
      .returningAll()
      .executeTakeFirstOrThrow()

    return await loadViewDetail(tx, updated, access, viaShare)
  })
})
