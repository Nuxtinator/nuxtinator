// POST /api/inbox/conversations/:id/contact
// Body: { name }. Creates a CRM contact from the conversation's counterparty:
// the record is created through the CRM patch pipeline, which claims + links
// the email channel itself — so the new contact is immediately connected to
// this (and every other) conversation on that address.

import { z } from 'zod'
import { withOrgPermission } from '#tenant/server'
import { requireTypePermission, applyFieldPatch } from '#records/server'

const Body = z.object({
  name: z.string().min(1).max(300)
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.access', async (tx, ctx) => {
    const conversation = await inboxGetConversation(tx, id)
    if (!conversation) {
      throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
    }
    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }

    await requireTypePermission(tx, ctx, 'contacts', 'create')

    const channel = await tx
      .selectFrom('crm_channels')
      .select('value')
      .where('id', '=', conversation.channel_id)
      .executeTakeFirstOrThrow()

    const record = await applyFieldPatch(tx, ctx, 'contacts', null, {
      name: parsed.data.name,
      contact_email: { values: [{ value: channel.value, primary: true }] }
    })
    return { id: record.id, name: record.name }
  })
})
