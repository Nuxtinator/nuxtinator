// POST /api/workflows/views — create a view. Requires CRM read on the
// record type (a view over a type you cannot read would always be empty)
// and validates the definition against the type's real fields.
import { z } from 'zod'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { requireRecordType, requireTypePermission } from '#crm/server'
import { sanitizeWorkflowsDefinition, toWorkflowsViewDetail } from '../../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  icon: z.string().max(64).optional(),
  recordTypeKey: z.string().min(1).max(80),
  viewType: z.enum(['kanban', 'table']),
  visibility: z.enum(['private', 'shared', 'org']).optional(),
  definition: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data

    await requireTypePermission(tx, ctx, body.recordTypeKey, 'read')
    await requireRecordType(tx, body.recordTypeKey)
    const definition = await sanitizeWorkflowsDefinition(tx, body.recordTypeKey, body.viewType, body.definition)

    const view = await tx
      .insertInto('workflows_views')
      .values({
        name: body.name,
        icon: body.icon ?? null,
        record_type_key: body.recordTypeKey,
        view_type: body.viewType,
        visibility: body.visibility ?? 'private',
        owner_id: ctx.userId,
        // jsonb params bind reliably only through the text cast (same
        // pattern as CRM's record storage).
        definition: sql`${JSON.stringify(definition)}::text::jsonb`
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const owner = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', ctx.userId)
      .executeTakeFirstOrThrow()

    return toWorkflowsViewDetail(view, 'owner', owner.display_name)
  })
})
