import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { SeedContext } from '#core/seeds/types'
import type { InboxConversationsTable, InboxMessagesTable, InboxCommentsTable } from '../server/database/schema'
// Runtime cross-layer import goes by package name: seeds run under bun with
// no Nuxt alias resolution. The records layer's normalizer keeps seeded
// channels dedupe-compatible with what the inbound webhook claims later.
import { normalizeChannelValue } from '@nuxtinator/records/normalize'
import type { CrmChannelsTable } from '../../crm/server/database/schema'

// Untyped pass-through: tenancy mode adds an `org_id` column at runtime that
// isn't reflected in this layer's compile-time schema, so we widen the rows
// with an optional org_id and rely on the runtime DEFAULT to fill it (via the
// `app.current_org` GUC set inside the transaction).
type InboxSeedDb = {
  inbox_conversations: InboxConversationsTable & { org_id?: string }
  inbox_messages: InboxMessagesTable & { org_id?: string }
  inbox_comments: InboxCommentsTable & { org_id?: string }
  crm_channels: CrmChannelsTable & { org_id?: string }
}

// Every seeded counterparty lives on this marker domain — it identifies seed
// data (nothing real ever mails from it) and drives idempotency: a channel on
// it that already owns a conversation is skipped on re-runs.
const SEED_DOMAIN = 'seed.example'

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

function hoursAfter(base: Date, h: number): Date {
  return new Date(base.getTime() + h * 60 * 60 * 1000)
}

function toHtml(text: string): string {
  return text.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
}

type SeedUserKey = 'admin' | 'alice' | 'bob' | 'carol'

interface MessageSeed {
  direction: 'inbound' | 'outbound'
  // received | held (inbound) · delivered | sent | queued | draft (outbound)
  status: string
  body: string
  hoursAfter: number
  /** outbound: which demo user sent/authored it. */
  sender?: SeedUserKey
  /** held only: the mismatched sender address + the hold reason. */
  heldFrom?: string
  holdReason?: string
}

interface ConversationSeed {
  sender: { name: string, email: string }
  subject: string
  status: 'open' | 'pending' | 'closed'
  source: 'inbound_email' | 'contact_form'
  needsReview?: boolean
  assigned?: SeedUserKey
  startedDaysAgo: number
  messages: MessageSeed[]
  comments?: Array<{ author: SeedUserKey, body: string }>
}

// Six threads covering the states the UI treats differently: a fresh
// unassigned inquiry, a delivered back-and-forth, a pending reply, a held
// (sender-mismatch) review case, a shared draft in progress, and a
// contact-form submission.
const CONVERSATIONS: ConversationSeed[] = [
  {
    sender: { name: 'Nora Fields', email: `nora.fields@${SEED_DOMAIN}` },
    subject: 'Question about your plans',
    status: 'open',
    source: 'inbound_email',
    startedDaysAgo: 1,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Hi,\n\nDo you offer a plan for small teams? We are four people and the individual tier looks too limited for us.\n\nThanks,\nNora'
      }
    ]
  },
  {
    sender: { name: 'Owen Hart', email: `owen.hart@${SEED_DOMAIN}` },
    subject: 'Can’t log in to my account',
    status: 'open',
    source: 'inbound_email',
    assigned: 'alice',
    startedDaysAgo: 3,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Hello,\n\nSince yesterday the login page just spins after I enter my password. I already tried resetting it.\n\nOwen'
      },
      {
        direction: 'outbound',
        status: 'delivered',
        sender: 'alice',
        hoursAfter: 2,
        body: 'Hi Owen,\n\nSorry about that! We rolled back a change this morning — could you clear your browser cache and try again?\n\nBest,\nAlice'
      },
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 5,
        body: 'That did it — I’m back in. Thanks for the quick help!'
      }
    ],
    comments: [
      { author: 'alice', body: 'Same cache issue as the other reports from Tuesday’s deploy.' }
    ]
  },
  {
    sender: { name: 'Grace Chen', email: `grace.chen@${SEED_DOMAIN}` },
    subject: 'Invoice for March',
    status: 'pending',
    source: 'inbound_email',
    assigned: 'bob',
    startedDaysAgo: 5,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Hi,\n\nCould you resend the March invoice? The PDF in the original email won’t open.\n\nGrace'
      },
      {
        direction: 'outbound',
        status: 'sent',
        sender: 'bob',
        hoursAfter: 26,
        body: 'Hi Grace,\n\nOf course — I’ve attached a fresh copy. Let me know if this one opens for you.\n\nBob'
      }
    ]
  },
  {
    sender: { name: 'Miles Turner', email: `miles.turner@${SEED_DOMAIN}` },
    subject: 'Re: Your delivery schedule',
    status: 'open',
    source: 'inbound_email',
    needsReview: true,
    startedDaysAgo: 2,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Hi, what days do you deliver to the north side?\n\nMiles'
      },
      {
        direction: 'inbound',
        status: 'held',
        hoursAfter: 8,
        heldFrom: `assistant@other-company.${SEED_DOMAIN}`,
        holdReason: 'Sender does not match this conversation',
        body: 'Following up on Miles’ question — I handle his scheduling. Please reply to me directly.'
      }
    ]
  },
  {
    sender: { name: 'Ada Novak', email: `ada.novak@${SEED_DOMAIN}` },
    subject: 'Feature request: calendar export',
    status: 'open',
    source: 'inbound_email',
    startedDaysAgo: 4,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Hello!\n\nIs there a way to export my bookings to a calendar feed? An iCal URL would be perfect.\n\nAda'
      },
      {
        direction: 'outbound',
        status: 'draft',
        sender: 'admin',
        hoursAfter: 20,
        body: 'Hi Ada,\n\nNot yet, but it’s on our roadmap — I’ll make sure your vote is counted. In the meantime you can [describe the CSV workaround here].\n\nThanks for the suggestion!'
      }
    ],
    comments: [
      { author: 'admin', body: 'Drafted a reply — someone who knows the export roadmap should fill in the workaround before sending.' }
    ]
  },
  {
    sender: { name: 'Website Visitor', email: `visitor@${SEED_DOMAIN}` },
    subject: 'Do you ship internationally?',
    status: 'closed',
    source: 'contact_form',
    startedDaysAgo: 9,
    messages: [
      {
        direction: 'inbound',
        status: 'received',
        hoursAfter: 0,
        body: 'Do you ship internationally?\n\nI’m in Portugal and couldn’t find shipping info on the site.'
      },
      {
        direction: 'outbound',
        status: 'delivered',
        sender: 'carol',
        hoursAfter: 3,
        body: 'Hi!\n\nYes — we ship to most of the EU including Portugal. Shipping is calculated at checkout.\n\nCarol'
      }
    ]
  }
]

// Get-or-create the shared identity row for an address (the seed-side twin of
// the kernel's claimChannel), matching crm's normalization so later webhook
// claims land on the same row.
async function ensureChannel(db: Kysely<InboxSeedDb>, value: string): Promise<string> {
  const { normalized } = normalizeChannelValue('email', value)
  const existing = await db
    .selectFrom('crm_channels')
    .select('id')
    .where('channel_type', '=', 'email')
    .where('normalized_value', '=', normalized)
    .executeTakeFirst()
  if (existing) return existing.id
  const inserted = await db
    .insertInto('crm_channels')
    .values({ channel_type: 'email', value: value.trim(), normalized_value: normalized })
    .returning('id')
    .executeTakeFirstOrThrow()
  return inserted.id
}

async function ensureConversation(
  db: Kysely<InboxSeedDb>,
  seed: ConversationSeed,
  users: Map<SeedUserKey, { id: string, displayName: string }>,
  log: SeedContext['log']
): Promise<void> {
  const channelId = await ensureChannel(db, seed.sender.email)

  const existing = await db
    .selectFrom('inbox_conversations')
    .select('id')
    .where('channel_id', '=', channelId)
    .executeTakeFirst()
  if (existing) {
    log(`conversation (exists): ${seed.subject}`)
    return
  }

  const startedAt = daysAgo(seed.startedDaysAgo)
  const assignee = seed.assigned ? users.get(seed.assigned) : undefined
  const conversation = await db
    .insertInto('inbox_conversations')
    .values({
      channel_id: channelId,
      subject: seed.subject,
      status: seed.status,
      assigned_user_id: assignee?.id ?? null,
      reply_token: randomBytes(10).toString('hex'),
      needs_review: seed.needsReview ?? false,
      source: seed.source,
      counterparty_name: seed.sender.name,
      created_at: startedAt,
      updated_at: startedAt
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  let lastAt = startedAt
  let lastDirection: 'inbound' | 'outbound' = 'inbound'
  for (const [i, msg] of seed.messages.entries()) {
    const at = hoursAfter(startedAt, msg.hoursAfter)
    const sender = msg.sender ? users.get(msg.sender) : undefined
    const inbound = msg.direction === 'inbound'
    const isReply = i > 0
    await db
      .insertInto('inbox_messages')
      .values({
        conversation_id: conversation.id,
        direction: msg.direction,
        status: msg.status,
        sender_user_id: sender?.id ?? null,
        from_email: inbound
          ? (msg.heldFrom ?? seed.sender.email)
          : null,
        from_name: inbound
          ? (msg.heldFrom ? null : seed.sender.name)
          : (sender?.displayName ?? null),
        to_email: inbound ? `contact@inbox.${SEED_DOMAIN}` : seed.sender.email,
        subject: isReply ? `Re: ${seed.subject.replace(/^Re:\s*/i, '')}` : seed.subject,
        body_html: toHtml(msg.body),
        body_stripped_html: inbound ? toHtml(msg.body) : null,
        body_text: msg.body,
        // Deterministic per (conversation, index) — a backstop against dupes
        // beyond the channel-level skip above.
        email_message_id: `<seed-inbox-${channelId}-${i}@${SEED_DOMAIN}>`,
        authenticated: inbound && !msg.heldFrom,
        hold_reason: msg.holdReason ?? null,
        provider_message_id: !inbound && (msg.status === 'sent' || msg.status === 'delivered')
          ? `<seed-inbox-out-${channelId}-${i}@${SEED_DOMAIN}>`
          : null,
        delivered_at: msg.status === 'delivered' ? hoursAfter(at, 0.1) : null,
        created_at: at,
        updated_at: at
      })
      .execute()
    // Held messages never move the conversation's activity cursor (they are
    // quarantined, not part of the thread flow).
    if (msg.status !== 'held' && msg.status !== 'draft') {
      lastAt = at
      lastDirection = msg.direction
    }
  }

  await db
    .updateTable('inbox_conversations')
    .set({ last_message_at: lastAt, last_message_direction: lastDirection, updated_at: lastAt })
    .where('id', '=', conversation.id)
    .execute()

  for (const [i, comment] of (seed.comments ?? []).entries()) {
    const author = users.get(comment.author)
    if (!author) continue
    const at = hoursAfter(startedAt, 1 + i)
    await db
      .insertInto('inbox_comments')
      .values({
        conversation_id: conversation.id,
        author_id: author.id,
        author_label: null,
        body: `<p>${comment.body}</p>`,
        created_at: at,
        updated_at: at
      })
      .execute()
  }

  const parts = [
    `${seed.messages.length} messages`,
    seed.comments?.length ? `${seed.comments.length} notes` : null
  ].filter(Boolean).join(', ')
  log(`conversation (new):    ${seed.subject} (${parts})`)
}

export default async function seed(ctx: SeedContext): Promise<void> {
  const db = ctx.db as Kysely<InboxSeedDb>

  const adminUser = ctx.users.find(u => u.isAdmin)
  if (!adminUser) {
    ctx.log('inbox: no admin user, skipping')
    return
  }
  const users = new Map<SeedUserKey, { id: string, displayName: string }>()
  users.set('admin', { id: adminUser.id, displayName: adminUser.displayName })
  for (const key of ['alice', 'bob', 'carol'] as const) {
    const user = ctx.users.find(u => u.email === `${key}@example.com`)
    if (user) users.set(key, { id: user.id, displayName: user.displayName })
  }

  // Multi-tenant mode: inbox_* and crm_channels rows are org-scoped via
  // NOT NULL org_id DEFAULT current_org_id(). Mirror the runtime pattern from
  // defineTenantHandler — open a transaction, SET LOCAL the GUC, run the
  // inserts so the column DEFAULT resolves to the demo org. Single-tenant
  // mode skips the SET LOCAL because the column doesn't exist.
  await db.transaction().execute(async (tx) => {
    const t = tx as unknown as Kysely<InboxSeedDb>
    if (ctx.orgId) {
      await sql`SET LOCAL app.current_org = ${sql.lit(ctx.orgId)}`.execute(tx)
    }
    for (const conversation of CONVERSATIONS) {
      await ensureConversation(t, conversation, users, ctx.log)
    }
  })
}
