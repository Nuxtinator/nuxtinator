// DELETE /api/crm/records/:type/:id/channels/:linkId
// Detaches the address from the record. The channel identity row and the
// consent/suppression history hanging off it remain — only the link goes.
// Permission: the record-visibility rule plus the record-scoped update gate
// (type update answer OR an edit-level share on this record).

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireRecordUpdate } from '../../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../../utils/list-records'
import { unlinkChannel } from '../../../../../../../utils/channels'
import { assertNotAccountOwned } from '../../../../../../../utils/account-link'

const uuidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  const linkId = getRouterParam(event, 'linkId')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await requireRecordUpdate(tx, ctx, typeKey, id)

    if (!uuidSchema.safeParse(linkId).success) {
      throw createError({ statusCode: 404, statusMessage: 'Channel link not found.' })
    }
    const link = await tx
      .selectFrom('crm_contact_channels as cc')
      .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
      .select('ch.channel_type as channel_type')
      .where('cc.id', '=', linkId)
      .where('cc.record_id', '=', id)
      .executeTakeFirst()
    if (link) await assertNotAccountOwned(tx, id, { channelType: link.channel_type })
    await unlinkChannel(tx, ctx, id, linkId)
    return { ok: true }
  })
})
