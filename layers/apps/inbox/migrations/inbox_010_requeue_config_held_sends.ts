import { type Kysely, sql } from 'kysely'

// Rescues staff replies that an earlier send-sweep marked permanently 'failed'
// purely because the org had no contact address configured. A missing setting
// is not a delivery failure: those messages were written by a person, reported
// as sent, and never left the building. They are returned to the queue with a
// fresh attempt budget and a hold reason, so the sweep sends them as soon as
// an address exists.
//
// Matched on the exact reason the old code wrote, so genuine provider failures
// are untouched — and it is a no-op on any deployment the bug never hit.
const OLD_REASON = 'Inbox contact address not configured'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE inbox_messages
    SET status = 'queued',
        hold_reason = ${OLD_REASON},
        failed_reason = NULL,
        attempts = 0,
        next_attempt_at = NULL,
        updated_at = now()
    WHERE status = 'failed'
      AND failed_reason = ${OLD_REASON}
  `.execute(db)
}

// Irreversible by design: the rows are indistinguishable from replies held by
// the current code once requeued, and re-failing them would recreate the data
// loss this migration exists to undo.
export async function down(): Promise<void> {}
