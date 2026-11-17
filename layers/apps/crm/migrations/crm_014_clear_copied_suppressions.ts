import { type Kysely, sql } from 'kysely'

// The mail kernel's list is the one source for bounces and complaints on
// email channels, so CRM's active rows of those reasons (copied there by
// crm_013) are cleared and kept as history. Manual blocks stay CRM's own.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update crm_channel_suppressions s
    set cleared_at = now()
    from crm_channels c
    where c.id = s.channel_id
      and c.channel_type = 'email'
      and s.cleared_at is null
      and s.reason in ('hard_bounce', 'complaint')
  `.execute(db)
}

export async function down(): Promise<void> {}
