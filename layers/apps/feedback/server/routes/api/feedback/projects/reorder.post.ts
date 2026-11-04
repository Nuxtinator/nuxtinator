import { readBody } from 'h3'
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) ?? {}
  const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : []

  if (orderedIds.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds array is required' })
  }
  if (orderedIds.some((id: unknown) => typeof id !== 'string')) {
    throw createError({ statusCode: 400, statusMessage: 'orderedIds must be strings' })
  }

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      const projectId = orderedIds[i] as string
      // Use `jsonb_set` instead of `||` with a stringified object. postgres-js
      // auto-JSON-encodes JS strings when the target is jsonb, which would
      // turn `'{"sort_order":0}'::jsonb` into a JSON string scalar, and
      // `||` of (object, scalar) produces an array — silently breaking the
      // subsequent `(post_meta->>'sort_order')::int` sort.
      await tx
        .updateTable('projects')
        .set({
          post_meta: sql`jsonb_set(coalesce(post_meta, '{}'::jsonb), '{sort_order}', to_jsonb(${i}::int))`,
          updated_at: sql`now()`
        })
        .where('id', '=', projectId)
        .execute()
    }

    const rows = await tx
      .selectFrom('projects')
      .selectAll()
      .where('id', 'in', orderedIds as string[])
      .orderBy(sql`coalesce((post_meta->>'sort_order')::int, 9999)`)
      .orderBy('created_at')
      .execute()

    return rows
  })
})
