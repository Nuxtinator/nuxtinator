// POST /api/views — create a view owned by the caller. Requires read on the
// record type and validates the definition against the type's real fields
// (see createView).
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { createView } from '../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().max(64).optional(),
  recordTypeKey: z.string().min(1).max(80),
  viewType: z.enum(['kanban', 'table']),
  visibility: z.enum(['private', 'shared', 'org']).optional(),
  definition: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'views' }, 'views.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    return await createView(tx, ctx, parsed.data)
  })
})
