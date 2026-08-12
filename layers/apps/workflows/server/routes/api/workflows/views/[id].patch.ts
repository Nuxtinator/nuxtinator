// PATCH /api/workflows/views/:id — partial update. name/icon/definition
// need 'edit'; visibility is the owner's call (it decides who can reach the
// view at all). view_type and record_type_key are immutable — converting a
// view is a create-new operation.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { sql } from 'kysely'
import { requireWorkflowsView, sanitizeWorkflowsDefinition, toWorkflowsViewDetail } from '../../../../utils/views'

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().max(64).nullable().optional(),
  visibility: z.enum(['private', 'shared', 'org']).optional(),
  definition: z.unknown().optional()
}).strict()

export default defineEventHandler(async (event) => {
  const viewId = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'workflows' }, 'workflows.use', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data

    const needed = body.visibility !== undefined ? 'owner' : 'edit'
    const { view, access } = await requireWorkflowsView(tx, ctx, viewId, needed)

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.icon !== undefined) patch.icon = body.icon
    if (body.visibility !== undefined) patch.visibility = body.visibility
    if (body.definition !== undefined) {
      const definition = await sanitizeWorkflowsDefinition(tx, view.record_type_key, view.view_type, body.definition)
      // jsonb params bind reliably only through the text cast (same pattern
      // as CRM's record storage).
      patch.definition = sql`${JSON.stringify(definition)}::text::jsonb`
    }
    if (Object.keys(patch).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Empty patch' })
    }
    patch.updated_at = sql`now()`

    const updated = await tx
      .updateTable('workflows_views')
      .set(patch)
      .where('id', '=', viewId)
      .returningAll()
      .executeTakeFirstOrThrow()

    const owner = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', updated.owner_id)
      .executeTakeFirstOrThrow()

    return toWorkflowsViewDetail(updated, access, owner.display_name)
  })
})
