// Record display timeline writer. crm_record_activity is the record-keyed
// timeline shown on the detail page — it cascades away with the record.
// Compliance-grade consent history lives in crm_consent_events (channel-keyed,
// survives record deletion) and is written by the consent service, not here.
// Core's activity_logs are untouched by the CRM kernel.

import { sql } from 'kysely'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import type { TenantContext } from '#tenant/server'

// Well-known actions plus freeform system actions (carried with a `note`).
export type CrmActivityAction
  = | 'created'
    | 'field_changed'
    | 'channel_linked'
    | 'channel_unlinked'
    | 'consent_changed'
    | 'shared'
    | 'unshared'
    | 'deleted'
    | (string & {})

export interface CrmActivityOpts {
  fieldKey?: string
  old?: unknown
  new?: unknown
  /** Human-readable message for events not tied to a field. */
  note?: string
  /** Display name for system/magic-link actors; wins over user-name resolution. */
  actorLabel?: string
}

export async function recordCrmActivity(
  tx: Transaction<Database>,
  ctx: TenantContext,
  recordId: string,
  action: CrmActivityAction,
  opts: CrmActivityOpts = {}
): Promise<void> {
  await tx
    .insertInto('crm_record_activity')
    .values({
      record_id: recordId,
      actor_user_id: ctx.userId,
      actor_label: opts.actorLabel ?? null,
      action,
      field_key: opts.fieldKey ?? null,
      // ::text::jsonb — the ::text stop forces the driver to bind the
      // pre-stringified value as plain text (postgres-js would otherwise
      // JSON-encode the string a second time, storing a jsonb string scalar);
      // Postgres then parses the text into the real jsonb value.
      old_value: sql`${JSON.stringify(opts.old ?? null)}::text::jsonb`,
      new_value: sql`${JSON.stringify(opts.new ?? null)}::text::jsonb`,
      note: opts.note ?? null,
      client_id: ctx.clientId ?? null
    })
    .execute()
}
