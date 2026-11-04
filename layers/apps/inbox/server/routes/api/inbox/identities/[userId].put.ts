// PUT /api/inbox/identities/:userId { alias?, signature? }
// Split permission model: changing an ALIAS (routable = attack surface) or
// touching ANOTHER user's identity requires inbox.settings.manage; a user may edit
// only their OWN signature at the inbox.send tier. `undefined`/absent leaves a
// field untouched; explicit `null` clears it.
import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { logEvent } from '#core/server/utils/activity-logger'

const Body = z.object({
  alias: z.string().max(64).nullable().optional(),
  signature: z.string().max(20_000).nullable().optional()
})

export default defineEventHandler(async (event) => {
  const userId = getRouterParam(event, 'userId')!
  if (!z.string().uuid().safeParse(userId).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid user id' })
  }
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx, ctx) => {
    const raw = await readBody(event)
    const parsed = Body.safeParse(raw)
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    // `alias` present in the payload (even as null) is an alias change.
    const rawObj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const changingAlias = Object.prototype.hasOwnProperty.call(rawObj, 'alias')
    const editingOther = userId !== ctx.userId
    if ((changingAlias || editingOther) && !ctx.perms.has('inbox.settings.manage')) {
      throw createError({ statusCode: 403, statusMessage: 'Only an inbox settings manager can change sending aliases or another user’s identity' })
    }

    const patch: { alias?: string | null, signature?: string | null } = {}
    if (changingAlias) {
      patch.alias = parsed.data.alias == null ? null : inboxNormalizeAlias(parsed.data.alias)
    }
    if (parsed.data.signature !== undefined) patch.signature = parsed.data.signature

    // The target must exist, and GRANTING an alias additionally requires the
    // target to be assignable — an org member who can open the inbox (the
    // assignees rule). An alias is routable: inbound mail to it auto-assigns
    // the conversation, so handing one to a user without inbox access would
    // silently blackhole threads. Clearing an alias or editing a signature
    // carries no such risk and stays allowed for any existing user.
    const target = await tx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
    if (!target) {
      throw createError({ statusCode: 404, statusMessage: 'User not found' })
    }
    if (changingAlias && patch.alias != null) {
      const assignable = await inboxUsersWithAccess(tx, ctx.orgId)
      if (!assignable.includes(userId)) {
        throw createError({ statusCode: 400, statusMessage: 'Only an org member with inbox access can hold a sending alias' })
      }
    }

    try {
      const before = await inboxGetIdentity(tx, userId)
      const { row, changed } = await inboxUpsertIdentity(tx, userId, patch)
      // Audit each field that actually moved, in the same transaction so the
      // trail commits with the change. Aliases are routable (they redirect
      // inbound assignment), so the alias entry carries from/to; signature
      // bodies are large HTML and are logged as a change only.
      for (const field of changed) {
        await logEvent({
          eventType: 'inbox_identity_updated',
          userId: ctx.userId,
          metadata: {
            message: field === 'alias' ? 'Sending alias changed' : 'Signature updated',
            targetUserId: userId,
            field,
            ...(field === 'alias' ? { from: before?.alias ?? null, to: row.alias } : {})
          }
        }, tx)
      }
      return { userId: row.user_id, alias: row.alias, signature: row.signature }
    } catch (err) {
      // A taken alias surfaces as a Postgres unique violation — return a
      // friendly 400 rather than a 500.
      if ((err as { code?: string })?.code === '23505') {
        throw createError({ statusCode: 400, statusMessage: 'That alias is already taken' })
      }
      // The users FK can still trip if the target is deleted between the
      // existence check and the upsert.
      if ((err as { code?: string })?.code === '23503') {
        throw createError({ statusCode: 404, statusMessage: 'User not found' })
      }
      throw err
    }
  })
})
