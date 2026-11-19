// Fields an admin adds in the schema builder that hand records to people or
// hold files, and the tags field every type has: always shown, suggesting the
// tags already used on the type's records the caller can see.
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
afterEach(async () => {
  await cleanupRecordsTestData(sql)
})

type Opts = ReturnType<typeof withOrgHeader>

const TYPE = 'test_deliverable'

interface RecordDetail {
  id: string
  fields: Record<string, unknown>
}
interface FieldDef {
  key: string
  kind: string
  hidden: boolean
  multiple?: boolean
  custom: boolean
}

async function create(opts: Opts, type: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}`, {
    method: 'POST',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function patch(opts: Opts, type: string, id: string, fields: Record<string, unknown>, confirmShare = false): Promise<RecordDetail> {
  return await $fetch<RecordDetail>(`/api/records/entries/${type}/${id}`, {
    method: 'PATCH',
    body: confirmShare ? { fields, confirmShare } : { fields },
    ...opts
  })
}

async function canSee(opts: Opts, type: string, id: string): Promise<boolean> {
  return await $fetch(`/api/records/entries/${type}/${id}`, opts).then(() => true, () => false)
}

async function fieldsOf(opts: Opts, type: string): Promise<FieldDef[]> {
  return (await $fetch<{ fields: FieldDef[] }>(`/api/records/schema/types/${type}/fields`, opts)).fields
}

async function addField(opts: Opts, type: string, body: Record<string, unknown>) {
  return await $fetch(`/api/records/schema/types/${type}/fields`, { method: 'POST', body, ...opts })
}

async function tagsOf(opts: Opts, type: string, q?: string): Promise<string[]> {
  return (await $fetch<{ tags: string[] }>(`/api/records/entries/${type}/tags`, { query: q ? { q } : {}, ...opts })).tags
}

// An org whose admin made the type, with tasks under it and an Assignees
// field, plus two members.
async function setup() {
  const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
  const admin = withOrgHeader(auth, org.slug)
  await $fetch('/api/records/schema/types', {
    method: 'POST',
    body: { typeKey: TYPE, label: 'Deliverables', labelSingular: 'Deliverable' },
    ...admin
  })
  await addField(admin, TYPE, { fieldKey: 'work', kind: 'connection', label: 'Tasks', target: 'task', nesting: 'children' })
  await addField(admin, TYPE, { fieldKey: 'assignees', kind: 'user_select', label: 'Assignees' })
  const owner = await addRecordsMember(sql, org.id)
  const sam = await addRecordsMember(sql, org.id)
  return {
    admin,
    owner: withOrgHeader(owner.auth, org.slug),
    sam: withOrgHeader(sam.auth, org.slug),
    samId: sam.user.id
  }
}

describe('people fields an admin adds', () => {
  it('names several people, who see the record and what sits under it once the write is confirmed', async () => {
    const { admin, owner, sam, samId } = await setup()
    expect((await fieldsOf(admin, TYPE)).find(f => f.key === 'assignees')).toMatchObject({ kind: 'user_select', multiple: true, custom: true })

    const big = await create(owner, TYPE, { name: 'test-records Launch' })
    const task = await create(owner, 'task', { name: 'test-records Write copy', [TYPE]: [big.id] })
    expect(await canSee(sam, TYPE, big.id)).toBe(false)

    const refused = await patch(owner, TYPE, big.id, { assignees: [samId] }).catch(e => e)
    expect(refused.statusCode).toBe(409)
    expect(refused.data?.data?.code ?? refused.data?.code).toBe('records.share_confirmation')
    expect(await canSee(sam, TYPE, big.id)).toBe(false)

    const saved = await patch(owner, TYPE, big.id, { assignees: [samId] }, true)
    expect(saved.fields.assignees).toEqual([samId])
    expect(await canSee(sam, TYPE, big.id)).toBe(true)
    expect(await canSee(sam, 'task', task.id)).toBe(true)

    const sent = await sql<Array<{ title: string, link: string }>>`select title, link from notifications where user_id = ${samId}`
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toMatch(/ assigned you a deliverable$/)
    expect(sent[0]!.link).toBe(`/records/${TYPE}/${big.id}`)
  })

  it('takes a files field too', async () => {
    const { admin } = await setup()
    await addField(admin, TYPE, { fieldKey: 'files', kind: 'attachments', label: 'Files' })
    expect((await fieldsOf(admin, TYPE)).find(f => f.key === 'files')).toMatchObject({ kind: 'attachments', custom: true })
  })
})

describe('the tags field', () => {
  it('is on every type and can\'t be hidden', async () => {
    const { admin } = await setup()
    for (const type of [TYPE, 'task']) {
      expect((await fieldsOf(admin, type)).find(f => f.key === 'tags')).toMatchObject({ kind: 'tags', hidden: false })
      const hide = await $fetch(`/api/records/schema/types/${type}/fields/tags`, { method: 'PATCH', body: { hidden: true }, ...admin }).catch(e => e)
      expect(hide.statusCode).toBe(400)
    }
    const again = await addField(admin, TYPE, { fieldKey: 'tags', kind: 'tags', label: 'More tags' }).catch(e => e)
    expect(again.statusCode).toBe(409)
  })

  it('suggests the type\'s tags on records the caller can see, most used first', async () => {
    const { owner, sam } = await setup()
    await create(owner, TYPE, { name: 'test-records Site', tags: ['MVP', 'Live'] })
    await create(owner, TYPE, { name: 'test-records App', tags: ['MVP'] })
    await create(sam, TYPE, { name: 'test-records Private', tags: ['Secret'] })
    await create(owner, 'task', { name: 'test-records Call', tags: ['Phone'] })

    expect(await tagsOf(owner, TYPE)).toEqual(['MVP', 'Live'])
    expect(await tagsOf(owner, TYPE, 'li')).toEqual(['Live'])
    expect(await tagsOf(sam, TYPE)).toEqual(['Secret'])
    expect(await tagsOf(owner, 'task')).toEqual(['Phone'])

    const notTags = await $fetch(`/api/records/entries/${TYPE}/tags`, { query: { field: 'name' }, ...owner }).catch(e => e)
    expect(notTags.statusCode).toBe(400)
  })
})
