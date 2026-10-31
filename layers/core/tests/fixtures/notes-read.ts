// GET /api/test-core-notes/:id — a note the caller can see under RLS, or 404.
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { sql } from 'kysely'
import { withUserPermission } from '#core/server/utils/personal-apps'

export default defineEventHandler(event =>
  withUserPermission(event, { appId: 'test-core-notes' }, 'test-core-notes.read' as never, async (tx) => {
    const id = getRouterParam(event, 'id')
    const { rows } = await sql<{ id: string, title: string }>`select id, title from test_core_notes where id = ${id}::uuid`.execute(tx)
    if (!rows[0]) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    return rows[0]
  }))
