import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { generateNKeysBetween } from 'fractional-indexing'
import type { SeedContext } from '#core/seeds/types'
import type {
  RecordsEntriesTable,
  RecordUserRefsTable,
  RecordConnectionsTable,
  RecordActivityTable,
  RecordTypesTable,
  RecordFieldsTable
} from '@nuxtinator/records/schema'
import type { ViewsViewsTable, ViewSharesTable, ViewTabsTable, ViewItemsTable } from '../server/database/schema'

// Demo project management: a "Deliverables" type the org made for itself,
// with its own statuses (Ideas, Waiting on others, Abandoned beside the usual
// three), and tasks nested under each deliverable to several levels. The
// "Deliverables" view holds them and is open to everyone to view and to Alice
// and Bob to edit, so everything under its cards is too; one of Alice's own
// task trees sits outside it and stays hers.

// Tenancy adds an `org_id` column at runtime, filled by its DEFAULT from the
// `app.current_org` GUC set inside the transaction.
type SeedDb = {
  records_entries: RecordsEntriesTable & { org_id?: string }
  records_user_refs: RecordUserRefsTable & { org_id?: string }
  records_connections: RecordConnectionsTable & { org_id?: string }
  records_activity: RecordActivityTable & { org_id?: string }
  records_types: RecordTypesTable & { org_id?: string }
  records_fields: RecordFieldsTable & { org_id?: string }
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

const VIEW_NAME = 'Deliverables'
const DELIVERABLE = 'deliverable'
/** The task field naming its deliverable, and the deliverable field listing its tasks. */
const PARENT_KEY = 'deliverable'
const CHILDREN_KEY = 'tasks'

type DeliverableStatus = 'ideas' | 'open' | 'in_progress' | 'waiting' | 'done' | 'abandoned'

interface DeliverableSeed {
  name: string
  status: DeliverableStatus
  quarter?: 'q1' | 'q2' | 'q3' | 'q4'
  /** Days from today. */
  target?: number
  summary?: string
  tasks?: TaskSeed[]
}

const DELIVERABLES: DeliverableSeed[] = [
  {
    name: 'Prayer Tools v3 rewrite',
    status: 'in_progress',
    quarter: 'q1',
    target: 75,
    summary: 'Rebuild Prayer Tools on the new platform: campaigns, sign-ups, reminders and landing pages.',
    tasks: [
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
    quarter: 'q1',
    target: 40,
    tasks: [
      { name: 'First TestFlight build', status: 'done', assignee: 'alice' },
      { name: 'Offline sync', status: 'in_progress', assignee: 'alice', due: 18 },
      { name: 'Push notifications', assignee: 'bob' },
      { name: 'Invite the beta testers', assignee: 'carol' }
    ]
  },
  {
    name: 'Partner dashboards',
    status: 'waiting',
    quarter: 'q2',
    target: 90,
    summary: 'Waiting on the partners to agree which numbers they want to see.',
    tasks: [
      { name: 'Choose the first five metrics', status: 'done', assignee: 'carol' },
      { name: 'Get sign-off from the partner leads', status: 'in_progress', assignee: 'carol' },
      { name: 'Build the dashboard page', assignee: 'bob' }
    ]
  },
  {
    name: 'Volunteer scheduling',
    status: 'open',
    quarter: 'q2',
    target: 110,
    tasks: [
      { name: 'Interview three team leaders', assignee: 'carol' },
      { name: 'Sketch the weekly rota screen', assignee: 'alice' }
    ]
  },
  { name: 'Annual report site', status: 'ideas', quarter: 'q3' },
  { name: 'Text-message reminders', status: 'ideas' },
  {
    name: 'Donor import',
    status: 'done',
    quarter: 'q4',
    tasks: [
      { name: 'Clean the spreadsheet', status: 'done', assignee: 'carol' },
      { name: 'Import and spot-check', status: 'done', assignee: 'alice' }
    ]
  },
  {
    name: 'Legacy forum migration',
    status: 'abandoned',
    summary: 'Dropped: the forum closes at the end of the year.',
    tasks: [
      { name: 'Export the forum threads', status: 'done', assignee: 'bob' },
      { name: 'Map forum accounts to users', assignee: 'bob' }
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
  ancestors: string[],
  deliverableId: string | null = null
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

  // Directly under a deliverable the link is the task's deliverable; deeper it's its parent task.
  const parentId = ancestors[ancestors.length - 1]
  if (parentId) {
    await db
      .insertInto('records_connections')
      .values({ from_record_id: row.id, field_key: parentId === deliverableId ? PARENT_KEY : 'parent', to_record_id: parentId, meta: jsonb({}) })
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
    count += (await insertTask(db, sub, users, creatorId, [...ancestors, row.id], deliverableId)).count
  }
  return { id: row.id, count }
}

// The Deliverables type as an org admin would make it in the schema builder:
// its own status options, a few fields, and tasks nested under it (a field on
// each side of the link).
async function insertDeliverableType(db: Kysely<SeedDb>, adminId: string): Promise<void> {
  await db
    .insertInto('records_types')
    .values({
      type_key: DELIVERABLE,
      label_override: 'Deliverables',
      label_singular_override: 'Deliverable',
      icon_override: 'i-lucide-package',
      is_custom: true,
      config: jsonb({
        card: { fields: ['status', 'quarter', 'target_date', CHILDREN_KEY], connections: { [CHILDREN_KEY]: 'progress' } }
      }),
      updated_by: adminId,
      updated_at: sql`now()`
    })
    .execute()
  const field = (
    typeKey: string,
    fieldKey: string,
    kind: string | null,
    label: string | null,
    order: number,
    config: Record<string, unknown>,
    icon: string | null = null,
    section: string | null = null
  ) => ({
    type_key: typeKey,
    field_key: fieldKey,
    kind,
    label_override: label,
    icon_override: icon,
    section_override: section,
    order_override: order,
    config: jsonb(config),
    updated_by: adminId,
    updated_at: sql`now()`
  })
  await db
    .insertInto('records_fields')
    .values([
      field(DELIVERABLE, 'status', null, null, 1, {
        options: {
          ideas: { label: 'Ideas', color: 'neutral' },
          open: { label: 'To do' },
          in_progress: { label: 'In progress', color: 'warning' },
          waiting: { label: 'Waiting on others', color: 'secondary' },
          abandoned: { label: 'Abandoned', color: 'neutral', closed: true }
        },
        optionOrder: ['ideas', 'open', 'in_progress', 'waiting', 'done', 'abandoned']
      }),
      field(DELIVERABLE, 'quarter', 'key_select', 'Quarter', 2, {
        options: { q1: { label: 'Q1' }, q2: { label: 'Q2' }, q3: { label: 'Q3' }, q4: { label: 'Q4' } },
        optionOrder: ['q1', 'q2', 'q3', 'q4']
      }, 'i-lucide-calendar-range'),
      field(DELIVERABLE, 'target_date', 'date', 'Target date', 3, {}, 'i-lucide-calendar'),
      field(DELIVERABLE, CHILDREN_KEY, 'connection', 'Tasks', 4, { target: 'task', hierarchy: 'children', reverseKey: PARENT_KEY }),
      field(DELIVERABLE, 'summary', 'textarea', 'Summary', 5, {}),
      // Beside the task's own "Parent task" row.
      field('task', PARENT_KEY, 'connection', 'Deliverable', 10, { target: DELIVERABLE, hierarchy: 'parent', reverseKey: CHILDREN_KEY }, null, 'details')
    ])
    .execute()
}

async function insertDeliverable(
  db: Kysely<SeedDb>,
  seed: DeliverableSeed,
  users: Map<SeedUserKey, string>,
  creatorId: string
): Promise<{ id: string, tasks: number }> {
  const data: Record<string, unknown> = {}
  if (seed.quarter) data.quarter = seed.quarter
  if (seed.target !== undefined) data.target_date = day(seed.target)
  if (seed.summary) data.summary = seed.summary
  const row = await db
    .insertInto('records_entries')
    .values({ record_type: DELIVERABLE, name: seed.name, status: seed.status, data: jsonb(data), created_by: creatorId })
    .returning('id')
    .executeTakeFirstOrThrow()
  await db
    .insertInto('records_activity')
    .values({
      record_id: row.id,
      actor_user_id: creatorId,
      actor_label: null,
      action: 'created',
      field_key: null,
      old_value: null,
      new_value: jsonb({ name: seed.name }),
      note: null
    })
    .execute()
  let tasks = 0
  for (const task of seed.tasks ?? []) {
    tasks += (await insertTask(db, task, users, creatorId, [row.id], row.id)).count
  }
  return { id: row.id, tasks }
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

    // An org that already has a deliverable type, or the task field, keeps its own.
    let typeTaken = t.selectFrom('records_types').select('id').where('type_key', '=', DELIVERABLE)
    let fieldTaken = t.selectFrom('records_fields').select('id').where('type_key', '=', 'task').where('field_key', '=', PARENT_KEY)
    if (ctx.orgId) {
      typeTaken = typeTaken.where('org_id', '=', ctx.orgId)
      fieldTaken = fieldTaken.where('org_id', '=', ctx.orgId)
    }
    if (await typeTaken.executeTakeFirst() || await fieldTaken.executeTakeFirst()) {
      ctx.log(`type (exists): ${DELIVERABLE}`)
      return
    }
    await insertDeliverableType(t, adminUser.id)

    // Everyone can open the view; Alice and Bob can also work its cards.
    const view = await t
      .insertInto('views_definitions')
      .values({
        name: VIEW_NAME,
        icon: 'i-lucide-package',
        record_type_key: DELIVERABLE,
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
    for (const deliverable of DELIVERABLES) {
      const { id, tasks } = await insertDeliverable(t, deliverable, users, adminUser.id)
      await t.insertInto('views_items').values({ view_id: view.id, record_id: id, created_here: true }).execute()
      total += tasks
    }
    ctx.log(`view (new):    ${VIEW_NAME} (${DELIVERABLES.length} deliverables, ${total} tasks)`)

    const aliceId = users.get('alice')
    if (aliceId) {
      const { count } = await insertTask(t, ALICE_PRIVATE, users, aliceId, [])
      ctx.log(`tasks (new):   ${ALICE_PRIVATE.name} (${count} tasks, Alice's own)`)
    }
  })
}
