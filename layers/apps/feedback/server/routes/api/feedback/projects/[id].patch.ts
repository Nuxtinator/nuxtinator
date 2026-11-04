import { getRouterParam, readBody } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'
import { logUpdate } from '#core/server/utils/activity-logger'
import { originOf } from '../../../../utils/widget-origins'

// Normalize an incoming allowed_origins list to deduped, valid origins
// (scheme + host[:port]). Throws 400 on any malformed entry.
function normalizeAllowedOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: 'allowed_origins must be an array' })
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const origin = originOf(entry.trim())
    if (!origin) {
      throw createError({ statusCode: 400, statusMessage: `invalid origin: ${entry}` })
    }
    if (!out.includes(origin)) out.push(origin)
  }
  return out
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })

  const body = await readBody(event) ?? {}

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const updates: Record<string, any> = {}
    if (typeof body.name === 'string') updates.name = body.name
    if ('description' in body) updates.description = body.description
    if (typeof body.is_expanded === 'boolean') updates.is_expanded = body.is_expanded
    if ('allowed_origins' in body) updates.allowed_origins = normalizeAllowedOrigins(body.allowed_origins)
    if (body.post_meta && typeof body.post_meta === 'object') updates.post_meta = body.post_meta

    if (Object.keys(updates).length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No fields to update' })
    }

    updates.updated_at = sql`now()`

    const row = await tx
      .updateTable('projects')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()

    if (!row) throw createError({ statusCode: 404, statusMessage: 'Project not found' })

    logUpdate('projects', id, ctx.userId, { fields: Object.keys(updates) })
    return row
  })
})
