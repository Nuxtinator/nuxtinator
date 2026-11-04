// PATCH /api/crm/records/:type/:id/channels/:linkId
// Body: { value?, label?, primary? } — at least one key. A value change never
// mutates the shared identity row (consent/suppression hang off it): the new
// address is claimed and the record is relinked (unlink old link, link new
// channel), preserving the old label/primary unless the body overrides them.
// Label/primary alone update the link row in place (primary via the
// clear-then-set flip). Returns the field's hydrated channel entries.
// Permission: the record-visibility rule plus the record-scoped update gate
// (type update answer OR an edit-level share on this record).

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import type { CrmChannelEntry } from '#crm'
import { requireRecordUpdate } from '../../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../../utils/list-records'
import { claimChannel, linkChannel, setPrimary, unlinkChannel } from '../../../../../../../utils/channels'
import { getRecord } from '../../../../../../../utils/record-storage'
import { assertNotAccountOwned } from '../../../../../../../utils/account-link'

const Body = z.object({
  value: z.string().min(1).optional(),
  label: z.string().nullable().optional(),
  primary: z.boolean().optional()
}).refine(
  b => b.value !== undefined || b.label !== undefined || b.primary !== undefined,
  { message: 'Nothing to update' }
)

const uuidSchema = z.string().uuid()

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  const linkId = getRouterParam(event, 'linkId')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await requireRecordUpdate(tx, ctx, typeKey, id)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data

    if (!uuidSchema.safeParse(linkId).success) {
      throw createError({ statusCode: 404, statusMessage: 'Channel link not found.' })
    }
    const link = await tx
      .selectFrom('crm_contact_channels as cc')
      .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
      .select([
        'cc.id as id',
        'cc.field_key as field_key',
        'cc.channel_id as channel_id',
        'cc.label as label',
        'cc.is_primary as is_primary',
        'ch.channel_type as channel_type'
      ])
      .where('cc.id', '=', linkId)
      .where('cc.record_id', '=', id)
      .executeTakeFirst()
    if (!link) {
      throw createError({ statusCode: 404, statusMessage: 'Channel link not found.' })
    }
    if (body.value !== undefined) await assertNotAccountOwned(tx, id, { channelType: link.channel_type })

    // A value resolving to a different identity row relinks; the same
    // identity (e.g. a formatting-only edit) falls through to the in-place
    // label/primary path.
    let relinked = false
    if (body.value !== undefined) {
      const channel = await claimChannel(tx, { channelType: link.channel_type, value: body.value })
      if (channel.id !== link.channel_id) {
        await unlinkChannel(tx, ctx, id, link.id)
        await linkChannel(tx, ctx, id, link.field_key, channel.id, {
          label: body.label !== undefined ? body.label : link.label,
          primary: body.primary !== undefined ? body.primary : link.is_primary
        })
        relinked = true
      }
    }

    if (!relinked) {
      if (body.label !== undefined) {
        await tx
          .updateTable('crm_contact_channels')
          .set({ label: body.label })
          .where('id', '=', link.id)
          .execute()
      }
      if (body.primary === true) {
        await setPrimary(tx, id, link.field_key, link.id)
      } else if (body.primary === false && link.is_primary) {
        await tx
          .updateTable('crm_contact_channels')
          .set({ is_primary: false })
          .where('id', '=', link.id)
          .execute()
      }
    }

    const record = await getRecord(tx, ctx, typeKey, id)
    return {
      fieldKey: link.field_key,
      entries: (record.fields[link.field_key] ?? []) as CrmChannelEntry[]
    }
  })
})
