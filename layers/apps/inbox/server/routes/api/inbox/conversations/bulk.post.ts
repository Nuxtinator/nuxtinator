// POST /api/inbox/conversations/bulk
// Body: { ids: string[] (≤100), status?, assignedUserId?, addTags? } — the
// triage moves of PATCH /:id applied to a set of conversations at once. Spam
// is excluded in both directions: entering it blocklists the sender and
// leaving it un-blocklists, so both stay deliberate per-conversation actions.
// Ids that don't exist (or that RLS hides) are skipped; the response counts
// the conversations that actually changed.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'

const MAX_IDS = 100

const Body = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_IDS),
  status: z.enum(['open', 'pending', 'closed']).optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  // Elements are unknown, not string: non-string entries are narrowed away
  // below (the drop-silently contract of PUT /:id/tags).
  addTags: z.array(z.unknown()).max(50).optional()
}).refine(
  b => b.status !== undefined || b.assignedUserId !== undefined || b.addTags !== undefined,
  { message: 'No action given' }
)

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data
    const ids = [...new Set(body.ids)]
    const updated = new Set<string>()

    if (body.status !== undefined) {
      const changed = await inboxBulkUpdateStatus(tx, ids, body.status)
      // Closing resolves any pending review, as on the single endpoint.
      if (body.status === 'closed') {
        await inboxBulkClearNeedsReview(tx, changed.map(c => c.id))
      }
      for (const c of changed) {
        await inboxLogConversationEvent(tx, c.id, 'inbox_status_changed', `Status → ${body.status}`, {
          userId: ctx.userId, extra: { from: c.from, to: body.status, bulk: true }
        })
        updated.add(c.id)
      }
    }

    if (body.assignedUserId !== undefined) {
      if (body.assignedUserId) {
        const allowed = await inboxUsersWithAccess(tx, ctx.orgId)
        if (!allowed.includes(body.assignedUserId)) {
          throw createError({ statusCode: 400, statusMessage: 'Assignee cannot access the inbox' })
        }
      }
      const changed = await inboxBulkAssign(tx, ids, body.assignedUserId)
      for (const id of changed) {
        await inboxLogConversationEvent(
          tx, id,
          body.assignedUserId ? 'inbox_assigned' : 'inbox_unassigned',
          body.assignedUserId ? 'Assigned' : 'Unassigned',
          { userId: ctx.userId, extra: { assignedUserId: body.assignedUserId, bulk: true } }
        )
        updated.add(id)
      }
    }

    if (body.addTags !== undefined) {
      const palette = await inboxListTags(tx)
      const slugs = inboxSanitizeSlugs(palette, body.addTags.filter((t): t is string => typeof t === 'string'))
      if (slugs.length > 0) {
        const changed = await inboxBulkAddTags(tx, ids, slugs)
        for (const id of changed) {
          await inboxLogConversationEvent(tx, id, 'inbox_tags_updated', 'Tags added', {
            userId: ctx.userId, extra: { tags: slugs, bulk: true }
          })
          updated.add(id)
        }
      }
    }

    return { updated: updated.size }
  })
})
