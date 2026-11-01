import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { SeedContext } from '#core/seeds/types'
import type {
  CrmRecordsTable,
  CrmRecordFieldEntriesTable,
  CrmRecordUserRefsTable,
  CrmRecordConnectionsTable,
  CrmChannelsTable,
  CrmContactChannelsTable,
  CrmChannelConsentsTable,
  CrmConsentEventsTable,
  CrmRecordActivityTable,
  CrmRecordCommentsTable
} from '../server/database/schema'
import { normalizeChannelValue, channelFingerprint } from '../server/utils/normalize'

// Untyped pass-through: tenancy mode adds an `org_id` column at runtime that
// isn't reflected in this layer's compile-time schema, so we widen the rows
// with an optional org_id and rely on the runtime DEFAULT to fill it (via the
// `app.current_org` GUC set inside the transaction).
type CrmSeedDb = {
  crm_records: CrmRecordsTable & { org_id?: string }
  crm_record_field_entries: CrmRecordFieldEntriesTable & { org_id?: string }
  crm_record_user_refs: CrmRecordUserRefsTable & { org_id?: string }
  crm_record_connections: CrmRecordConnectionsTable & { org_id?: string }
  crm_channels: CrmChannelsTable & { org_id?: string }
  crm_contact_channels: CrmContactChannelsTable & { org_id?: string }
  crm_channel_consents: CrmChannelConsentsTable & { org_id?: string }
  crm_consent_events: CrmConsentEventsTable & { org_id?: string }
  crm_record_activity: CrmRecordActivityTable & { org_id?: string }
  crm_record_comments: CrmRecordCommentsTable & { org_id?: string }
}

// House style for jsonb binds (matches the kernel): pre-stringify and route
// through ::text so the driver can't JSON-encode the value a second time.
function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::text::jsonb`
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

type SeedUserKey = 'admin' | 'alice' | 'bob' | 'carol'

interface ChannelSeed {
  field: 'contact_email' | 'contact_phone'
  type: 'email' | 'phone'
  value: string
  primary?: boolean
  /** purpose → opt_in/opt_out; source lands on the state + event rows. */
  consents?: Array<{ purpose: string, status: 'opt_in' | 'opt_out', source: string }>
}

interface ContactSeed {
  name: string
  status: 'new' | 'active' | 'paused' | 'closed'
  /** jsonb scalars (nickname, gender). */
  data?: Record<string, unknown>
  /** entry-stored multi values keyed by field. */
  entries?: Partial<Record<'languages' | 'sources' | 'tags', string[]>>
  assigned?: SeedUserKey[]
  channels?: ChannelSeed[]
  comments?: Array<{ author: SeedUserKey, body: string }>
  /** created_at offset so lists don't show eight identical timestamps. */
  createdDaysAgo: number
}

// Eight demo contacts covering every storage class: promoted columns,
// jsonb scalars, entries, user refs, channels (one address shared across two
// records), consent in both directions, one connection pair, and comments.
const CONTACTS: ContactSeed[] = [
  {
    name: 'Jane Miller',
    status: 'active',
    data: { nickname: 'Janey', gender: 'female' },
    entries: { languages: ['en', 'es'], sources: ['web'], tags: ['vip', 'newsletter'] },
    assigned: ['alice'],
    channels: [
      {
        field: 'contact_email',
        type: 'email',
        value: 'jane.miller@example.com',
        primary: true,
        consents: [
          { purpose: 'marketing', status: 'opt_in', source: 'form' },
          { purpose: 'transactional', status: 'opt_in', source: 'form' }
        ]
      },
      { field: 'contact_phone', type: 'phone', value: '+1 (555) 010-0001' }
    ],
    comments: [
      { author: 'admin', body: 'Met Jane at the spring open house — wants the monthly newsletter.' },
      { author: 'alice', body: 'Followed up by phone; she prefers email.' }
    ],
    createdDaysAgo: 30
  },
  {
    name: 'Marcus Webb',
    status: 'new',
    data: { gender: 'male' },
    entries: { sources: ['personal'] },
    assigned: ['bob'],
    channels: [
      {
        field: 'contact_email',
        type: 'email',
        value: 'marcus.webb@example.com',
        primary: true,
        consents: [{ purpose: 'marketing', status: 'opt_out', source: 'verbal' }]
      }
    ],
    createdDaysAgo: 21
  },
  {
    name: 'Priya Sharma',
    status: 'active',
    data: { nickname: 'Pri', gender: 'female' },
    entries: { languages: ['en'], tags: ['vip'] },
    assigned: ['alice', 'carol'],
    channels: [
      {
        field: 'contact_email',
        type: 'email',
        value: 'priya.sharma@example.com',
        primary: true,
        consents: [{ purpose: 'marketing', status: 'opt_in', source: 'form' }]
      },
      { field: 'contact_phone', type: 'phone', value: '+1 (555) 010-0003' }
    ],
    createdDaysAgo: 18
  },
  {
    name: 'Diego Alvarez',
    status: 'paused',
    data: { gender: 'male' },
    entries: { languages: ['es'], sources: ['transfer'] },
    channels: [
      { field: 'contact_phone', type: 'phone', value: '+1 (555) 010-0004', primary: true }
    ],
    createdDaysAgo: 14
  },
  {
    name: 'Amara Okafor',
    status: 'active',
    entries: { tags: ['volunteer'], sources: ['personal'] },
    assigned: ['carol'],
    channels: [
      { field: 'contact_email', type: 'email', value: 'amara.okafor@example.com', primary: true }
    ],
    createdDaysAgo: 10
  },
  // Tom and Sarah share the family inbox: two records linking one
  // crm_channels row — the shared-identity path the link table exists for.
  {
    name: 'Tom Bennett',
    status: 'closed',
    data: { gender: 'male', reason_closed: 'moved' },
    channels: [
      {
        field: 'contact_email',
        type: 'email',
        value: 'bennetts@example.com',
        primary: true,
        consents: [{ purpose: 'marketing', status: 'opt_in', source: 'verbal' }]
      },
      { field: 'contact_phone', type: 'phone', value: '+1 (555) 010-0006' }
    ],
    comments: [
      { author: 'bob', body: 'Household record — shares the family inbox with Sarah.' }
    ],
    createdDaysAgo: 7
  },
  {
    name: 'Sarah Bennett',
    status: 'active',
    data: { gender: 'female' },
    entries: { languages: ['en', 'fr'] },
    assigned: ['bob'],
    channels: [
      { field: 'contact_email', type: 'email', value: 'bennetts@example.com', primary: true },
      { field: 'contact_phone', type: 'phone', value: '+1 (555) 010-0007' }
    ],
    createdDaysAgo: 7
  },
  {
    name: "Liam O'Connor",
    status: 'new',
    entries: { sources: ['web'] },
    channels: [
      {
        field: 'contact_email',
        type: 'email',
        value: 'liam.oconnor@example.com',
        primary: true,
        consents: [{ purpose: 'marketing', status: 'opt_out', source: 'form' }]
      }
    ],
    createdDaysAgo: 2
  }
]

/** relation edges (from → to, both must be seeded names). */
const RELATIONS: Array<[string, string]> = [
  ['Tom Bennett', 'Sarah Bennett']
]

// Get-or-create the shared identity row for an address (the seed-side twin
// of the kernel's claimChannel).
async function ensureChannel(
  db: Kysely<CrmSeedDb>,
  type: 'email' | 'phone',
  value: string
): Promise<string> {
  const { normalized } = normalizeChannelValue(type, value)
  const existing = await db
    .selectFrom('crm_channels')
    .select('id')
    .where('channel_type', '=', type)
    .where('normalized_value', '=', normalized)
    .executeTakeFirst()
  if (existing) return existing.id
  const inserted = await db
    .insertInto('crm_channels')
    .values({ channel_type: type, value: value.trim(), normalized_value: normalized })
    .returning('id')
    .executeTakeFirstOrThrow()
  return inserted.id
}

// Consent state + one compliance event, only when the (channel, purpose)
// pair has no state yet — re-runs stay quiet, mirroring the service's
// idempotency rule.
async function ensureConsent(
  db: Kysely<CrmSeedDb>,
  channelId: string,
  channel: { type: string, value: string },
  consent: { purpose: string, status: 'opt_in' | 'opt_out', source: string },
  actorId: string,
  at: Date
): Promise<boolean> {
  const inserted = await db
    .insertInto('crm_channel_consents')
    .values({
      channel_id: channelId,
      purpose: consent.purpose,
      status: consent.status,
      granted_at: consent.status === 'opt_in' ? at : null,
      revoked_at: consent.status === 'opt_out' ? at : null,
      source: consent.source,
      capture_meta: jsonb({})
    })
    .onConflict(oc => oc.doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted) return false
  const { normalized } = normalizeChannelValue(channel.type as 'email' | 'phone', channel.value)
  await db
    .insertInto('crm_consent_events')
    .values({
      channel_id: channelId,
      channel_value: channel.value,
      address_fingerprint: channelFingerprint(channel.type, normalized),
      purpose: consent.purpose,
      event: consent.status === 'opt_in' ? 'grant' : 'revoke',
      source: consent.source,
      actor_user_id: actorId,
      ip: null,
      user_agent: null,
      meta: jsonb({}),
      occurred_at: at
    })
    .execute()
  return true
}

async function ensureContact(
  db: Kysely<CrmSeedDb>,
  contact: ContactSeed,
  users: Map<SeedUserKey, { id: string }>,
  adminId: string,
  log: SeedContext['log']
): Promise<string | null> {
  const existing = await db
    .selectFrom('crm_records')
    .select('id')
    .where('record_type', '=', 'contacts')
    .where('name', '=', contact.name)
    .executeTakeFirst()
  if (existing) {
    log(`contact (exists): ${contact.name}`)
    return existing.id
  }

  const createdAt = daysAgo(contact.createdDaysAgo)
  const record = await db
    .insertInto('crm_records')
    .values({
      record_type: 'contacts',
      name: contact.name,
      status: contact.status,
      data: jsonb(contact.data ?? {}),
      created_by: adminId,
      created_at: createdAt,
      updated_at: createdAt
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const recordId = record.id

  // Entry-stored multi values (multi_select / tags).
  for (const [fieldKey, values] of Object.entries(contact.entries ?? {})) {
    if (!values || values.length === 0) continue
    await db
      .insertInto('crm_record_field_entries')
      .values(values.map((value, i) => ({
        record_id: recordId,
        field_key: fieldKey,
        payload: jsonb({ value }),
        normalized_value: value,
        sort_order: i
      })))
      .onConflict(oc => oc.doNothing())
      .execute()
  }

  // Assignment (assigned_to is a multi user_select).
  for (const key of contact.assigned ?? []) {
    const user = users.get(key)
    if (!user) continue
    await db
      .insertInto('crm_record_user_refs')
      .values({ record_id: recordId, field_key: 'assigned_to', user_id: user.id, created_by: adminId })
      .onConflict(oc => oc.doNothing())
      .execute()
  }

  // Channels: shared identity rows + per-record links + consent state.
  for (const [i, ch] of (contact.channels ?? []).entries()) {
    const channelId = await ensureChannel(db, ch.type, ch.value)
    await db
      .insertInto('crm_contact_channels')
      .values({
        record_id: recordId,
        channel_id: channelId,
        field_key: ch.field,
        label: null,
        is_primary: ch.primary ?? false,
        sort_order: i
      })
      .onConflict(oc => oc.doNothing())
      .execute()
    for (const consent of ch.consents ?? []) {
      await ensureConsent(db, channelId, { type: ch.type, value: ch.value }, consent, adminId, createdAt)
    }
  }

  // A 'created' activity row so the timeline has an anchor entry.
  await db
    .insertInto('crm_record_activity')
    .values({
      record_id: recordId,
      actor_user_id: adminId,
      actor_label: null,
      action: 'created',
      field_key: null,
      old_value: null,
      new_value: jsonb({ name: contact.name }),
      note: null,
      created_at: createdAt
    })
    .execute()

  for (const [i, comment] of (contact.comments ?? []).entries()) {
    const author = users.get(comment.author)
    if (!author) continue
    const at = new Date(createdAt.getTime() + (i + 1) * 60 * 60 * 1000)
    await db
      .insertInto('crm_record_comments')
      .values({
        record_id: recordId,
        author_id: author.id,
        author_label: null,
        body: comment.body,
        created_at: at,
        updated_at: at
      })
      .execute()
  }

  const parts = [
    contact.channels?.length ? `${contact.channels.length} channels` : null,
    contact.comments?.length ? `${contact.comments.length} comments` : null
  ].filter(Boolean).join(', ')
  log(`contact (new):    ${contact.name}${parts ? ` (${parts})` : ''}`)
  return recordId
}

export default async function seed(ctx: SeedContext): Promise<void> {
  const db = ctx.db as Kysely<CrmSeedDb>

  const adminUser = ctx.users.find(u => u.isAdmin)
  if (!adminUser) {
    ctx.log('crm: no admin user, skipping')
    return
  }
  const users = new Map<SeedUserKey, { id: string }>()
  users.set('admin', { id: adminUser.id })
  for (const key of ['alice', 'bob', 'carol'] as const) {
    const user = ctx.users.find(u => u.email === `${key}@example.com`)
    if (user) users.set(key, { id: user.id })
  }

  // Multi-tenant mode: every crm_* row is org-scoped via NOT NULL org_id
  // DEFAULT current_org_id(). Mirror the runtime pattern from
  // defineTenantHandler — open a transaction, SET LOCAL the GUC, run the
  // inserts so the column DEFAULT resolves to the demo org. Single-tenant
  // mode skips the SET LOCAL because the column doesn't exist.
  await db.transaction().execute(async (tx) => {
    const t = tx as unknown as Kysely<CrmSeedDb>
    if (ctx.orgId) {
      await sql`SET LOCAL app.current_org = ${sql.lit(ctx.orgId)}`.execute(tx)
    }

    const idsByName = new Map<string, string>()
    for (const contact of CONTACTS) {
      const id = await ensureContact(t, contact, users, adminUser.id, ctx.log)
      if (id) idsByName.set(contact.name, id)
    }

    for (const [fromName, toName] of RELATIONS) {
      const fromId = idsByName.get(fromName)
      const toId = idsByName.get(toName)
      if (!fromId || !toId) continue
      await t
        .insertInto('crm_record_connections')
        .values({ from_record_id: fromId, field_key: 'relation', to_record_id: toId, meta: jsonb({}) })
        .onConflict(oc => oc.doNothing())
        .execute()
    }
  })
}
