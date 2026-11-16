import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { generateNKeysBetween } from 'fractional-indexing'
import type { SeedContext } from '#core/seeds/types'
import type {
  RecordsEntriesTable,
  RecordUserRefsTable,
  RecordConnectionsTable,
  RecordActivityTable
} from '@nuxtinator/records/schema'
import type { ViewsViewsTable, ViewSharesTable, ViewTabsTable, ViewItemsTable } from '../server/database/schema'

// Demo project management: a "Roadmap" view holding the big cards everyone
// follows, each broken down into subtasks to several levels. The roadmap is
// open to everyone to view and to Alice and Bob to edit, so everything under
// its cards is too; one of Alice's own task trees sits outside it and stays
// hers. Open a card's subtasks to walk down a level at a time.

// Tenancy adds an `org_id` column at runtime, filled by its DEFAULT from the
// `app.current_org` GUC set inside the transaction.
type SeedDb = {
  records_entries: RecordsEntriesTable & { org_id?: string }
  records_user_refs: RecordUserRefsTable & { org_id?: string }
  records_connections: RecordConnectionsTable & { org_id?: string }
  records_activity: RecordActivityTable & { org_id?: string }
  views_definitions: ViewsViewsTable & { org_id?: string }
  views_shares: ViewSharesTable & { org_id?: string }
  views_tabs: ViewTabsTable & { org_id?: string }
  views_items: ViewItemsTable & { org_id?: string }
}

function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::text::jsonb`
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

type SeedUserKey = 'admin' | 'alice' | 'bob' | 'carol'
type Status = 'open' | 'in_progress' | 'done'

interface TaskSeed {
  name: string
  status?: Status
  assignee?: SeedUserKey
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  /** Days from today. */
  due?: number
  description?: string
  subtasks?: TaskSeed[]
}

const ROADMAP_NAME = 'Roadmap'

const ROADMAP: TaskSeed[] = [
  {
    name: 'Prayer Tools v3 rewrite',
    status: 'in_progress',
    assignee: 'bob',
    priority: 'high',
    due: 75,
    description: 'Rebuild Prayer Tools on the new platform: campaigns, sign-ups, reminders and landing pages.',
    subtasks: [
      { name: 'Audit the v2 features still in use', status: 'done', assignee: 'alice' },
      {
        name: 'Data model and migration',
        status: 'in_progress',
        assignee: 'alice',
        priority: 'high',
        due: 14,
        subtasks: [
          { name: 'Map v2 tables to the v3 schema', status: 'done', assignee: 'alice' },
          { name: 'Write the migration script', status: 'in_progress', assignee: 'alice', due: 7 },
          { name: 'Dry run against a production copy', assignee: 'bob', due: 12 },
          { name: 'Plan the cut-over weekend', assignee: 'admin' }
        ]
      },
      {
        name: 'Prayer campaign API',
        status: 'in_progress',
        assignee: 'bob',
        due: 30,
        subtasks: [
          { name: 'Campaign endpoints', status: 'done', assignee: 'bob' },
          {
            name: 'Sign-ups and reminders',
            status: 'in_progress',
            assignee: 'bob',
            due: 21,
            subtasks: [
              { name: 'Email reminders', status: 'done', assignee: 'bob' },
              { name: 'Time zone handling', status: 'in_progress', assignee: 'alice', priority: 'urgent', due: 5 },
              { name: 'Push reminders', assignee: 'bob' },
              { name: 'Unsubscribe links', assignee: 'alice' }
            ]
          },
          { name: 'Rate limiting', assignee: 'alice' },
          { name: 'API docs for partners' }
        ]
      },
      {
        name: 'Campaign landing pages',
        assignee: 'alice',
        due: 45,
        subtasks: [
          { name: 'Design review with the campaigns team', status: 'in_progress', assignee: 'carol', due: 9 },
          { name: 'Build the page templates', assignee: 'alice' },
          { name: 'Translations', assignee: 'carol' }
        ]
      },
      {
        name: 'Launch checklist',
        due: 70,
        subtasks: [
          { name: 'Redirect the old URLs', assignee: 'bob' },
          { name: 'Email campaign owners', assignee: 'carol' },
          { name: 'Watch error rates for a week' }
        ]
      }
    ]
  },
  {
    name: 'Mobile app beta',
    status: 'in_progress',
    assignee: 'alice',
    priority: 'medium',
    due: 40,
    subtasks: [
      { name: 'First TestFlight build', status: 'done', assignee: 'alice' },
      { name: 'Offline sync', status: 'in_progress', assignee: 'alice', due: 18 },
      { name: 'Push notifications', assignee: 'bob' },
      { name: 'Invite the beta testers', assignee: 'carol' }
    ]
  },
  {
    name: 'Partner dashboards',
    assignee: 'bob',
    priority: 'medium',
    due: 90,
    subtasks: [
      { name: 'Choose the first five metrics', status: 'done', assignee: 'carol' },
      { name: 'Build the dashboard page', assignee: 'bob' }
    ]
  },
  { name: 'Annual report site', priority: 'low', due: 120, assignee: 'carol' },
  {
    name: 'Donor import',
    status: 'done',
    assignee: 'alice',
    subtasks: [
      { name: 'Clean the spreadsheet', status: 'done', assignee: 'carol' },
      { name: 'Import and spot-check', status: 'done', assignee: 'alice' }
    ]
  }
]

const ALICE_PRIVATE: TaskSeed = {
  name: 'Plan the team retreat',
  status: 'in_progress',
  assignee: 'alice',
  due: 28,
  subtasks: [
    { name: 'Shortlist venues', status: 'done', assignee: 'alice' },
    { name: 'Collect dietary needs', assignee: 'alice' },
    { name: 'Book travel', assignee: 'alice' }
  ]
}

async function insertTask(
  db: Kysely<SeedDb>,
  task: TaskSeed,
  users: Map<SeedUserKey, string>,
  creatorId: string,
  ancestors: string[]
): Promise<{ id: string, count: number }> {
  const data: Record<string, unknown> = {}
  if (task.priority) data.priority = task.priority
  if (task.due !== undefined) data.due_date = day(task.due)
  if (task.description) data.description = task.description
  const row = await db
    .insertInto('records_entries')
    .values({
      record_type: 'task',
      name: task.name,
      status: task.status ?? 'open',
      data: jsonb(data),
      created_by: creatorId,
      ancestor_ids: sql<string[]>`${sql.val(ancestors)}::uuid[]`
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const parentId = ancestors[ancestors.length - 1]
  if (parentId) {
    await db
      .insertInto('records_connections')
      .values({ from_record_id: row.id, field_key: 'parent', to_record_id: parentId, meta: jsonb({}) })
      .execute()
  }
  const assigneeId = task.assignee ? users.get(task.assignee) : undefined
  if (assigneeId) {
    await db
      .insertInto('records_user_refs')
      .values({ record_id: row.id, field_key: 'assignee', user_id: assigneeId, created_by: creatorId })
      .execute()
  }
  await db
    .insertInto('records_activity')
    .values({
      record_id: row.id,
      actor_user_id: creatorId,
      actor_label: null,
      action: 'created',
      field_key: null,
      old_value: null,
      new_value: jsonb({ name: task.name }),
      note: null
    })
    .execute()

  let count = 1
  for (const sub of task.subtasks ?? []) {
    count += (await insertTask(db, sub, users, creatorId, [...ancestors, row.id])).count
  }
  return { id: row.id, count }
}

export default async function seed(ctx: SeedContext): Promise<void> {
  const db = ctx.db as Kysely<SeedDb>

  const adminUser = ctx.users.find(u => u.isAdmin)
  if (!adminUser) {
    ctx.log('views: no admin user, skipping')
    return
  }
  const users = new Map<SeedUserKey, string>([['admin', adminUser.id]])
  for (const key of ['alice', 'bob', 'carol'] as const) {
    const user = ctx.users.find(u => u.email === `${key}@example.com`)
    if (user) users.set(key, user.id)
  }

  await db.transaction().execute(async (tx) => {
    const t = tx as unknown as Kysely<SeedDb>
    if (ctx.orgId) {
      await sql`SET LOCAL app.current_org = ${sql.lit(ctx.orgId)}`.execute(tx)
    }

    let existing = t
      .selectFrom('views_definitions')
      .select('id')
      .where('name', '=', ROADMAP_NAME)
      .where('owner_id', '=', adminUser.id)
    if (ctx.orgId) existing = existing.where('org_id', '=', ctx.orgId)
    if (await existing.executeTakeFirst()) {
      ctx.log(`view (exists): ${ROADMAP_NAME}`)
      return
    }

    // Everyone can open the roadmap; Alice and Bob can also work its cards.
    const view = await t
      .insertInto('views_definitions')
      .values({
        name: ROADMAP_NAME,
        icon: 'i-lucide-map',
        record_type_key: 'task',
        visibility: 'org',
        org_level: null,
        owner_id: adminUser.id,
        definition: jsonb({ picked: true })
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const key of ['alice', 'bob'] as const) {
      const userId = users.get(key)
      if (userId) await t.insertInto('views_shares').values({ view_id: view.id, user_id: userId, level: 'edit' }).execute()
    }
    const [first, second] = generateNKeysBetween(null, null, 2)
    await t
      .insertInto('views_tabs')
      .values([
        { view_id: view.id, name: 'Board', layout: 'kanban', position: first!, definition: jsonb({ groupField: 'status' }) },
        { view_id: view.id, name: 'List', layout: 'list', position: second!, definition: jsonb({}) }
      ])
      .execute()

    let total = 0
    for (const task of ROADMAP) {
      const { id, count } = await insertTask(t, task, users, adminUser.id, [])
      await t.insertInto('views_items').values({ view_id: view.id, record_id: id, created_here: true }).execute()
      total += count
    }
    ctx.log(`view (new):    ${ROADMAP_NAME} (${ROADMAP.length} cards, ${total} tasks)`)

    const aliceId = users.get('alice')
    if (aliceId) {
      const { count } = await insertTask(t, ALICE_PRIVATE, users, aliceId, [])
      ctx.log(`tasks (new):   ${ALICE_PRIVATE.name} (${count} tasks, Alice's own)`)
    }
  })
}
