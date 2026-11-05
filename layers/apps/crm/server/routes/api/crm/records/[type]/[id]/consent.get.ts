// GET /api/crm/records/:type/:id/consent
// Consent overview for every channel linked to the record: current
// per-purpose state, active-suppression flag, and the 20 most recent
// compliance events per channel — plus the code-registered purpose catalog so
// capture UIs can offer purposes that have no state rows yet. A channel
// linked under several fields appears once. Permission: the type evaluator's
// read answer plus the record-visibility rule.

import { withOrgContext } from '#tenant/server'
import { assertRecordVisible, requireRecordType, requireTypePermission } from '#records/server'
import { getRegisteredConsentPurposes } from '../../../../../../utils/crm-registry'
import { getConsentEvents, getConsentState, type ConsentEventEntry } from '../../../../../../utils/consent'
import { getActiveSuppressions } from '../../../../../../utils/suppression'

const EVENTS_PER_CHANNEL = 20

export default defineEventHandler(async (event) => {
  const typeKey = getRouterParam(event, 'type')!
  const id = getRouterParam(event, 'id')!
  return await withOrgContext(event, { appId: 'crm' }, async (tx, ctx) => {
    await requireTypePermission(tx, ctx, typeKey, 'read')
    await requireRecordType(tx, typeKey)
    await assertRecordVisible(tx, ctx, typeKey, id)

    const links = await tx
      .selectFrom('crm_contact_channels as cc')
      .innerJoin('crm_channels as ch', 'ch.id', 'cc.channel_id')
      .select([
        'cc.channel_id as channel_id',
        'ch.channel_type as channel_type',
        'ch.value as value'
      ])
      .where('cc.record_id', '=', id)
      .orderBy('cc.sort_order', 'asc')
      .execute()
    const channels = [...new Map(links.map(l => [l.channel_id, l])).values()]
    const channelIds = channels.map(c => c.channel_id)

    const consents = await getConsentState(tx, channelIds)
    const suppressions = await getActiveSuppressions(tx, channelIds)
    // Sequential per-channel event reads — queries on one transaction
    // connection must not interleave.
    const events = new Map<string, ConsentEventEntry[]>()
    for (const channelId of channelIds) {
      events.set(channelId, await getConsentEvents(tx, channelId, { limit: EVENTS_PER_CHANNEL }))
    }

    return {
      purposes: getRegisteredConsentPurposes(),
      channels: channels.map(c => ({
        channelId: c.channel_id,
        channelType: c.channel_type,
        value: c.value,
        consents: consents.get(c.channel_id) ?? [],
        suppressed: suppressions.has(c.channel_id),
        events: events.get(c.channel_id) ?? []
      }))
    }
  })
})
