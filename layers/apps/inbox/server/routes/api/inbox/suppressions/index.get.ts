// GET /api/inbox/suppressions → active deliverability suppressions org-wide,
// with the address and any linked contact records (registry-only channels —
// claimed but never linked — show an empty record list). inbox.send-gated; RLS
// scopes crm_channel_suppressions to the org.
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

export default defineEventHandler(async (event) => {
  return await withOrgPermission(event, { appId: 'inbox' }, 'inbox.send', async (tx) => {
    const rows = await tx
      .selectFrom('crm_channel_suppressions as s')
      .innerJoin('crm_channels as ch', 'ch.id', 's.channel_id')
      .leftJoin('crm_contact_channels as cc', 'cc.channel_id', 's.channel_id')
      .leftJoin('records_entries as r', 'r.id', 'cc.record_id')
      .select([
        's.channel_id as channel_id',
        's.reason as reason',
        's.detail as detail',
        's.source as source',
        's.created_at as created_at',
        'ch.value as value',
        sql<string[]>`COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}')`.as('record_names')
      ])
      .where('s.cleared_at', 'is', null)
      .groupBy(['s.channel_id', 's.reason', 's.detail', 's.source', 's.created_at', 'ch.value'])
      .orderBy('s.created_at', 'desc')
      .execute()

    return {
      items: rows.map(r => ({
        channelId: r.channel_id,
        value: r.value,
        reason: r.reason,
        detail: r.detail,
        source: r.source,
        since: r.created_at,
        recordNames: r.record_names
      }))
    }
  })
})
