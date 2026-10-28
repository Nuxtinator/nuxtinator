// POST /api/crm/records/:type/:id/channels
// Body: { channelTypeKey, fieldKey, value, label?, primary? } — claims the
// address (get-or-create of the shared identity row) and links it to the
// record under the given communication_channel field. The field must belong
// to the type and carry the given channel type. Returns the field's hydrated
// channel entries after the change. Permission: the record-visibility rule
// plus the record-scoped update gate (type update answer OR an edit-level
// share on this record).
//
// Sibling utils are imported by relative path: the #crm/server barrel is the
// consumer-layer surface, not the intra-layer one.

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import type { CrmChannelEntry } from '#crm'
import { requireRecordUpdate } from '../../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../../utils/list-records'
import { getRecordTypeFields } from '../../../../../../../utils/definition-settings'
import { claimChannel, linkChannel } from '../../../../../../../utils/channels'
import { getRecord } from '../../../../../../../utils/record-storage'
import { assertNotAccountOwned } from '../../../../../../../utils/account-link'

const Body = z.object({
  channelTypeKey: z.string().min(1),
  fieldKey: z.string().min(1),
  value: z.string().min(1),
  label: z.string().nullable().optional(),
  primary: z.boolean().optional()
})

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)
    await requireRecordUpdate(tx, ctx, typeKey, id)

    const parsed = Body.safeParse(await readBody(event))
    if (!parsed.success) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
    }
    const body = parsed.data

    const defs = await getRecordTypeFields(tx, typeKey)
    const def = defs.find(d => d.key === body.fieldKey && !d.orphan)
    if (!def || def.kind !== 'communication_channel') {
      throw createError({
        statusCode: 400,
        statusMessage: `${body.fieldKey} is not a communication channel field of ${typeKey}.`
      })
    }
    if (def.channelType !== body.channelTypeKey) {
      throw createError({
        statusCode: 400,
        statusMessage: `${body.fieldKey} holds ${def.channelType} channels, not ${body.channelTypeKey}.`
      })
    }

    await assertNotAccountOwned(tx, id, { channelType: def.channelType })

    const channel = await claimChannel(tx, { channelType: body.channelTypeKey, value: body.value })
    await linkChannel(tx, ctx, id, body.fieldKey, channel.id, {
      label: body.label,
      primary: body.primary
    })

    const record = await getRecord(tx, ctx, typeKey, id)
    return {
      fieldKey: body.fieldKey,
      entries: (record.fields[body.fieldKey] ?? []) as CrmChannelEntry[]
    }
  })
})
