// POST /api/crm/records/:type/:id/consent
// Body: { channelId, purpose, status: opt_in|opt_out, source: verbal|form|
// other, note? }. The channel must be linked to this record. Grants/revokes
// consent per (channel, purpose) — idempotent, so re-asserting the current
// state writes no event and no activity. The request ip + user agent land on
// the compliance event; the note travels in the event meta and the
// consent_changed activity row. Returns the channel's updated consent state.
// Permission: the record-visibility rule plus the record-scoped update gate
// (type update answer OR an edit-level share on this record).

import { z } from 'zod'
import { withOrgContext } from '#tenant/server'
import { requireRecordUpdate } from '../../../../../../utils/type-permissions'
import { assertRecordVisible, requireRecordType } from '../../../../../../utils/list-records'
import { grantConsent, revokeConsent, getConsentState } from '../../../../../../utils/consent'
import { isSuppressed } from '../../../../../../utils/suppression'
import { recordCrmActivity } from '../../../../../../utils/crm-activity'
import { getClientIp } from '#core/server/utils/client-ip'

const Body = z.object({
  channelId: z.string().uuid(),
  purpose: z.string().min(1),
  status: z.enum(['opt_in', 'opt_out']),
  // Code-owned capture-source vocabulary ('import' joins when import ships).
  source: z.enum(['verbal', 'form', 'other']),
  note: z.string().max(2000).optional()
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

    // Consent hangs off the channel, but this route's authority comes from
    // the record — the channel must actually be linked to it.
    const link = await tx
      .selectFrom('crm_contact_channels')
      .select('id')
      .where('record_id', '=', id)
      .where('channel_id', '=', body.channelId)
      .executeTakeFirst()
    if (!link) {
      throw createError({ statusCode: 400, statusMessage: 'Channel is not linked to this record.' })
    }

    const prior = (await getConsentState(tx, [body.channelId]))
      .get(body.channelId)
      ?.find(c => c.purpose === body.purpose) ?? null

    const change = {
      channelId: body.channelId,
      purpose: body.purpose,
      source: body.source,
      ip: getClientIp(event),
      userAgent: getHeader(event, 'user-agent') ?? null,
      captureMeta: body.note ? { note: body.note } : undefined
    }
    const result = body.status === 'opt_in'
      ? await grantConsent(tx, ctx, change)
      : await revokeConsent(tx, ctx, change)

    if (result.changed) {
      const channel = await tx
        .selectFrom('crm_channels')
        .select(['channel_type', 'value'])
        .where('id', '=', body.channelId)
        .executeTakeFirst()
      await recordCrmActivity(tx, ctx, id, 'consent_changed', {
        note: body.note,
        old: prior ? { purpose: prior.purpose, status: prior.status } : null,
        new: {
          channel_id: body.channelId,
          channel_type: channel?.channel_type,
          value: channel?.value,
          purpose: body.purpose,
          status: body.status,
          source: body.source
        }
      })
    }

    const consents = await getConsentState(tx, [body.channelId])
    return {
      channelId: body.channelId,
      consents: consents.get(body.channelId) ?? [],
      suppressed: await isSuppressed(tx, body.channelId),
      changed: result.changed
    }
  })
})
