import { type Kysely, sql } from 'kysely'

// Copies CRM's active delivery suppressions into the mail kernel's list, which
// is now the authority for bounces and complaints: hard bounces as global,
// complaints scoped to the channel's org (or the host in single mode). Manual
// blocks stay CRM's own. The CRM rows are left as history.
//
// On a fresh multi-mode database this runs before crm_T001 adds org_id, so
// the column's presence is checked rather than assumed.
export async function up(db: Kysely<unknown>): Promise<void> {
  const col = await sql<{ present: boolean }>`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'crm_channels' and column_name = 'org_id' and table_schema = current_schema()
    ) as present
  `.execute(db)
  const org = col.rows[0]?.present ? sql`c.org_id` : sql`null::uuid`
  await sql`
    insert into mail_suppressions (address_hash, org_id, scope, reason, detail, source, occurred_at)
    select encode(sha256(convert_to(lower(btrim(c.normalized_value)), 'UTF8')), 'hex'),
           case when s.reason = 'complaint' then ${org} else null end,
           case when s.reason = 'hard_bounce' then 'global' when ${org} is null then 'host' else 'org' end,
           s.reason, s.detail, s.source, s.created_at
    from crm_channel_suppressions s
    join crm_channels c on c.id = s.channel_id
    where s.cleared_at is null and s.reason in ('hard_bounce', 'complaint') and c.channel_type = 'email'
    on conflict do nothing
  `.execute(db)
}

export async function down(): Promise<void> {}
