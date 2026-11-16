// A repeat's next card joins the hand-picked views the closed one was on and
// takes its view field values and files, but no column, like any new card.
import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'
import { copyRecordAttachments, type RecordsRepeatEvent } from '#records/server'

export async function carryViewsCardsOnRepeat(
  tx: Transaction<Database>,
  ctx: TenantContext,
  event: RecordsRepeatEvent
): Promise<void> {
  await sql`
    INSERT INTO views_items (view_id, record_id, created_here)
    SELECT view_id, ${event.toRecordId}::uuid, created_here FROM views_items WHERE record_id = ${event.fromRecordId}::uuid
    ON CONFLICT DO NOTHING
  `.execute(tx)
  await sql`
    INSERT INTO views_values (view_id, record_id, field_key, value, updated_by)
    SELECT view_id, ${event.toRecordId}::uuid, field_key, value, ${ctx.userId}::uuid FROM views_values WHERE record_id = ${event.fromRecordId}::uuid
    ON CONFLICT DO NOTHING
  `.execute(tx)
  // Every view's files on the record (see viewAttachmentKey).
  await copyRecordAttachments(tx, ctx, event.fromRecordId, event.toRecordId, { fieldKeyPrefix: 'views:' })
}
