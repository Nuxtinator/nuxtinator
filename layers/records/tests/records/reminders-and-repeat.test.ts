// Reminders and repeating records. A reminder falls some time before the due
// date and goes to the record's assignees, else to whoever set it, once, and
// again after its day moves; a closed record's reminder is dropped. A record needs a due date to repeat,
// and closing one that repeats makes the next one, due one interval later,
// with its fields, shares and subtasks carried over.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

interface RecordDetail {
  id: string
  status: string | null
  fields: Record<string, unknown>
}

async function create(opts: Opts, type: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}`, {
    method: 'POST',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function patch(opts: Opts, type: string, id: string, fields: Record<string, unknown>): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}/${id}`, { method: 'PATCH', body: { fields }, ...opts })
}

async function get(opts: Opts, type: string, id: string): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}/${id}`, opts)
}

async function sweep(): Promise<void> {
  await $fetch('/api/_test/records-reminders', { method: 'POST' })
}

async function remindersFor(userId: string) {
  return await sql<Array<{ title: string, link: string, email_mode: string }>>`
    select title, link, email_mode from notifications where user_id = ${userId} and title like 'Reminder:%' order by created_at`
}

function day(offset: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function todayUtc(): string {
  return day(0)
}

describe('reminders', () => {
  it('go to the assignees on their day, once, and again when the due date moves', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)

    const task = await create(owner, 'task', { name: 'test-records Grant report', due_date: day(7), reminder: 'week_1', assignee: [sam.user.id] }, true)
    await create(owner, 'task', { name: 'test-records Later report', due_date: day(30), reminder: 'week_1', assignee: [sam.user.id] }, true)
    await sweep()
    expect(await remindersFor(sam.user.id)).toEqual([
      { title: 'Reminder: test-records Grant report', link: `/records/task/${task.id}`, email_mode: 'immediate' }
    ])
    expect(await remindersFor(user.id)).toEqual([])

    await sweep()
    expect(await remindersFor(sam.user.id)).toHaveLength(1)

    await patch(owner, 'task', task.id, { due_date: day(10) })
    const [row] = await sql<Array<{ remind_on: string, sent_at: Date | null }>>`
      select remind_on::text as remind_on, sent_at from records_reminders where record_id = ${task.id}`
    expect(row).toEqual({ remind_on: day(3), sent_at: null })
    await patch(owner, 'task', task.id, { reminder: 'due_day', due_date: day(0) })
    await sweep()
    expect(await remindersFor(sam.user.id)).toHaveLength(2)
  })

  it('go to whoever set them on a record with no assignees, and skip a day already past', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    await create(owner, 'task', { name: 'test-records Check the oil', due_date: day(1), reminder: 'day_1' })
    const late = await create(owner, 'task', { name: 'test-records Too late', due_date: day(1), reminder: 'week_1' })
    await sweep()
    expect((await remindersFor(user.id)).map(r => r.title)).toEqual(['Reminder: test-records Check the oil'])
    const [count] = await sql`select count(*)::int as n from records_reminders where record_id = ${late.id}`
    expect(count!.n).toBe(0)
  })

  it('need a due date, exist only on types with one, and are dropped for closed records', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    const noDate = await create(owner, 'task', { name: 'test-records No date', reminder: 'day_1' }).catch(e => e)
    expect(noDate.statusCode).toBe(400)
    const item = await create(owner, 'item', { name: 'test-records Item', reminder: 'day_1' }).catch(e => e)
    expect(item.statusCode).toBe(400)

    const done = await create(owner, 'task', { name: 'test-records Done already', due_date: day(0), reminder: 'due_day' })
    await patch(owner, 'task', done.id, { status: 'done' })
    const cleared = await create(owner, 'task', { name: 'test-records Never mind', due_date: day(0), reminder: 'due_day' })
    const after = await patch(owner, 'task', cleared.id, { due_date: null })
    expect(after.fields.reminder).toBeNull()
    await sweep()
    expect(await remindersFor(user.id)).toEqual([])
  })
})

describe('repeat', () => {
  it('needs a due date, and clearing the due date clears it', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    const err = await create(owner, 'task', { name: 'test-records No date', repeat: 'weekly' }).catch(e => e)
    expect(err.statusCode).toBe(400)

    const task = await create(owner, 'task', { name: 'test-records Weekly', due_date: '2030-01-07', repeat: 'weekly' })
    expect(task.fields.repeat).toBe('weekly')
    const after = await patch(owner, 'task', task.id, { due_date: null })
    expect(after.fields.repeat).toBeNull()
  })

  it('exists only on types with a due date', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    const err = await create(owner, 'item', { name: 'test-records Item', repeat: 'weekly' }).catch(e => e)
    expect(err.statusCode).toBe(400)
    const fields = await $fetch<{ dueField: string | null, fields: Array<{ key: string, due: boolean }> }>('/api/records/schema/types/task/fields', owner)
    expect(fields.dueField).toBe('due_date')
    expect(fields.fields.find(f => f.key === 'due_date')?.due).toBe(true)
  })

  it('makes the next record when one closes, on the schedule, with its fields, shares and subtasks', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const pat = await addRecordsMember(sql, org.id)

    const due = '2030-01-31'
    const task = await create(owner, 'task', {
      name: 'test-records Quarterly report',
      due_date: due,
      reminder: 'week_1',
      repeat: 'quarterly',
      assignee: [sam.user.id],
      tags: ['grants'],
      priority: 'high',
      description: 'Send the numbers.'
    }, true)
    await $fetch(`/api/records/entries/task/${task.id}/shares`, { method: 'POST', body: { userId: pat.user.id }, ...owner })
    const sub = await create(owner, 'task', { name: 'test-records Gather numbers', parent: [task.id], due_date: '2030-01-20' })
    await patch(owner, 'task', sub.id, { status: 'done' })

    const closed = await patch(owner, 'task', task.id, { status: 'done' })
    expect(closed.status).toBe('done')
    expect(closed.fields.repeat).toBeNull()

    const [next] = await sql<Array<{ id: string, created_by: string }>>`
      select id, created_by from records_entries where name = 'test-records Quarterly report' and id <> ${task.id}`
    expect(next).toBeTruthy()
    expect(next!.created_by).toBe(user.id)
    const copy = await get(owner, 'task', next!.id)
    expect(copy.status).toBe('open')
    expect(copy.fields).toMatchObject({
      due_date: '2030-04-30',
      reminder: 'week_1',
      repeat: 'quarterly',
      assignee: [sam.user.id],
      tags: ['grants'],
      priority: 'high',
      description: 'Send the numbers.'
    })
    const shares = await sql`select user_id from records_shares where record_id = ${next!.id}`
    expect(shares.map(s => s.user_id)).toEqual([pat.user.id])

    const subtasks = copy.fields.subtasks as Array<{ id: string }>
    expect(subtasks).toHaveLength(1)
    const subCopy = await get(owner, 'task', subtasks[0]!.id)
    expect(subCopy.status).toBe('open')
    expect(subCopy.fields.due_date).toBe('2030-04-20')

    const activity = await sql<Array<{ action: string }>>`select action from records_activity where record_id = ${task.id} and action = 'repeated'`
    expect(activity).toHaveLength(1)

    // The closed record no longer repeats: reopening and closing makes nothing more.
    await patch(owner, 'task', task.id, { status: 'open' })
    await patch(owner, 'task', task.id, { status: 'done' })
    const [count] = await sql`select count(*)::int as n from records_entries where name = 'test-records Quarterly report'`
    expect(count!.n).toBe(2)
  })

  it('moves a late record forward until its due date is no longer past', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)

    const task = await create(owner, 'task', { name: 'test-records Weekly check', due_date: '2020-01-06', repeat: 'weekly' })
    await patch(owner, 'task', task.id, { status: 'done' })
    const [next] = await sql<Array<{ data: { due_date: string } }>>`
      select data from records_entries where name = 'test-records Weekly check' and id <> ${task.id}`
    const nextDue = next!.data.due_date
    expect(nextDue >= todayUtc()).toBe(true)
    const days = (Date.parse(nextDue) - Date.parse('2020-01-06')) / 86_400_000
    expect(days % 7).toBe(0)
    expect(Date.parse(nextDue) - Date.parse(todayUtc())).toBeLessThan(7 * 86_400_000)
  })
})
