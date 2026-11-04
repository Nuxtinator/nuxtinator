// POST /api/list-of-100/contacts
// Creates a contact on the current user's list. Soft cap: no DB-side limit.
// The UI surfaces a warning past 100; the server allows the row.

import { z } from 'zod'
import { withUserPermission } from '#core/server/utils/personal-apps'
import { logCreate } from '#core/server/utils/activity-logger'

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  relationship: z.enum(['family', 'friend', 'coworker', 'neighbor', 'classmate', 'other']),
  faith_status: z.enum(['believer', 'non_believer', 'unknown']),
  notes: z.string().trim().max(2000).optional().nullable()
})

export default defineEventHandler(async (event) => {
  return await withUserPermission(event, { appId: 'list-of-100' }, 'list-of-100.write', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    const inserted = await tx
      .insertInto('list_of_100_contacts')
      .values({
        user_id: ctx.userId,
        name: parsed.data.name,
        relationship: parsed.data.relationship,
        faith_status: parsed.data.faith_status,
        notes: parsed.data.notes ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    logCreate('list_of_100_contacts', inserted.id, ctx.userId, { name: inserted.name })
    return { contact: inserted }
  })
})
