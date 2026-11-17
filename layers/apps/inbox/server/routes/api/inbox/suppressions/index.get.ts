// GET /api/inbox/suppressions → active deliverability suppressions org-wide,
// with the address and any linked contact records (registry-only channels —
// claimed but never linked — show an empty record list). inbox.send-gated; RLS
// scopes crm_channel_suppressions and crm_channels to the org.
//
// Two sources: CRM's own rows, which an org admin can clear here, and the mail
// kernel's list (bounces and complaints learned from providers, under the
// kernel's scope rule for this org), which only a host admin clears. CRM's
// row wins for a channel that has both.
import { sql } from 'kysely'
import { withOrgPermission } from '#tenant/server'

interface Row {
  channel_id: string
  reason: string
  detail: string | null
  source: string | null
  created_at: Date
  value: string
  record_names: string[]
}

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

    const kernel = await sql<Row>`
      select distinct on (ch.id) ch.id as channel_id, ms.reason, ms.detail, ms.source, ms.created_at, ch.value,
        coalesce((
          select array_agg(distinct r.name) from crm_contact_channels cc
          join records_entries r on r.id = cc.record_id
          where cc.channel_id = ch.id and r.name is not null
        ), '{}') as record_names
      from crm_channels ch
      join mail_suppressions ms
        on ms.address_hash = encode(sha256(convert_to(lower(btrim(ch.normalized_value)), 'UTF8')), 'hex')
       and ms.cleared_at is null
       and (ms.scope = 'global'
         or (ms.scope = 'org' and ms.org_id = nullif(current_setting('app.current_org', true), '')::uuid)
         or (ms.scope = 'host' and nullif(current_setting('app.current_org', true), '') is null))
      where ch.channel_type = 'email'
      order by ch.id, (ms.reason = 'complaint') desc
    `.execute(tx)

    const own = new Set(rows.map(r => r.channel_id))
    const items = [
      ...rows.map(r => ({ ...r, clearable: true })),
      ...kernel.rows.filter(r => !own.has(r.channel_id)).map(r => ({ ...r, clearable: false }))
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return {
      items: items.map(r => ({
        channelId: r.channel_id,
        value: r.value,
        reason: r.reason,
        detail: r.detail,
        source: r.source,
        since: r.created_at,
        recordNames: r.record_names,
        // False for the mail kernel's rows: a host admin clears those under
        // Admin → Email → Suppressions.
        clearable: r.clearable
      }))
    }
  })
})
