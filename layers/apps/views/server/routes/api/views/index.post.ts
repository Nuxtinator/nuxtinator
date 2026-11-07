// POST /api/views — create a view owned by the caller, with its first tab.
// Requires read on the record type and validates both definitions against
// the type's real fields (see createView). Visibility 'teams' takes
// `teamIds` (and `teamLevels`), checked like any later change of the view's
// teams; 'org' takes `orgLevel`.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { getTeamScope, setContainerTeams } from '#core/server/utils/team-access'
import { createView, loadViewDetail, requireView, setViewLevels, VIEWS_LAYOUTS } from '../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().max(64).optional(),
  recordTypeKey: z.string().min(1).max(80),
  visibility: z.enum(['private', 'org', 'teams']).optional(),
  teamIds: z.array(z.string().uuid()).max(100).optional(),
  teamLevels: z.record(z.string().uuid(), z.enum(['view', 'edit'])).optional(),
  orgLevel: z.enum(['view', 'edit']).optional(),
  definition: z.unknown().optional(),
  tab: z.object({
    name: z.string().trim().max(80).optional(),
    layout: z.enum(VIEWS_LAYOUTS),
    definition: z.unknown().optional()
  }).strict()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const { teamIds, teamLevels, orgLevel, visibility, ...input } = parsed.data
    if (visibility !== 'teams' && orgLevel !== 'edit') return await createView(tx, ctx, { ...input, visibility })

    const created = await createView(tx, ctx, { ...input, visibility: visibility === 'teams' ? 'private' : visibility })
    if (visibility === 'teams') {
      const scope = await getTeamScope(event, tx, ctx, 'views')
      await setContainerTeams(tx, scope, 'views_definitions', created.id, {
        visibility: 'teams',
        teamIds: [...new Set(teamIds ?? [])]
      })
    }
    await setViewLevels(tx, created.id, { visibility: visibility ?? 'private', orgLevel, teamLevels })
    const { view, access, viaShare } = await requireView(tx, ctx, created.id, 'owner')
    return await loadViewDetail(tx, view, access, viaShare)
  })
})
