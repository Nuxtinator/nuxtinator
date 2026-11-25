// Comments are rich text: images are files kept with the comment, and a
// mention tells the person, as one in a description does.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
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
  await sql`DELETE FROM records_attachment_trash WHERE storage_key LIKE 'records/test-records-%'`
})

type Opts = ReturnType<typeof withOrgHeader>

interface Comment {
  id: string
  body: string
  images: Array<{ id: string, name: string, url: string }>
}

async function createTask(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/task', {
    method: 'POST',
    body: { fields, confirmShare: true },
    ...opts
  })
}

async function comment(opts: Opts, taskId: string, body: string): Promise<Comment> {
  return await $fetch<Comment>(`/api/records/entries/task/${taskId}/comments`, { method: 'POST', body: { body }, ...opts })
}

async function seedFile(orgId: string, recordId: string, fieldKey: string, ageDays = 0): Promise<string> {
  const id = randomUUID()
  await sql`
    INSERT INTO records_attachments (id, record_id, field_key, storage_key, filename, mime, size_bytes, org_id, created_at)
    VALUES (${id}, ${recordId}, ${fieldKey}, ${`records/test-records-${id}.png`}, 'shot.png', 'image/png', 1234, ${orgId},
      now() - make_interval(days => ${ageDays}))
  `
  return id
}

async function fieldKeyOf(fileId: string): Promise<string | null> {
  const [row] = await sql<Array<{ field_key: string }>>`SELECT field_key FROM records_attachments WHERE id = ${fileId}`
  return row?.field_key ?? null
}

const image = (id: string) => `![x](attachment:${id})`

describe('comment images', () => {
  it('keeps the images a comment shows with the comment, and only the writer\'s own', async () => {
    const { org, auth, user } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const task = await createTask(owner, { name: 'test-records Screenshots', assignee: [sam.user.id] })

    const shot = await seedFile(org.id, task.id, `comment-draft:${user.id}`)
    const samsDraft = await seedFile(org.id, task.id, `comment-draft:${sam.user.id}`)
    const onTheCard = await seedFile(org.id, task.id, 'attachments')

    const posted = await comment(owner, task.id, `Look ${image(shot)} and ${image(samsDraft)} and ${image(onTheCard)}`)
    expect(posted.body).toBe(`Look ${image(shot)} and  and`)
    expect(posted.images.map(f => f.id)).toEqual([shot])
    expect(await fieldKeyOf(shot)).toBe(`comment:${posted.id}`)
    expect(await fieldKeyOf(samsDraft)).toBe(`comment-draft:${sam.user.id}`)
    expect(await fieldKeyOf(onTheCard)).toBe('attachments')

    const listed = await $fetch<{ items: Comment[] }>(`/api/records/entries/task/${task.id}/comments`, owner)
    expect(listed.items[0]!.images.map(f => f.id)).toEqual([shot])

    // Editing in a new image and out the old one deletes the old one's file.
    const chart = await seedFile(org.id, task.id, `comment-draft:${user.id}`)
    const edited = await $fetch<Comment>(`/api/records/comments/${posted.id}`, {
      method: 'PATCH',
      body: { body: `Now ${image(chart)}` },
      ...owner
    })
    expect(edited.images.map(f => f.id)).toEqual([chart])
    expect(await fieldKeyOf(shot)).toBeNull()
    const queued = await sql`SELECT 1 FROM records_attachment_trash WHERE storage_key = ${`records/test-records-${shot}.png`}`
    expect(queued).toHaveLength(1)

    // A comment that is only an image the writer can't use is empty.
    await expect(comment(owner, task.id, image(samsDraft))).rejects.toMatchObject({ statusCode: 400 })

    await $fetch(`/api/records/comments/${posted.id}`, { method: 'DELETE', ...owner })
    expect(await fieldKeyOf(chart)).toBeNull()
  })

  it('deletes drafts no comment took within a day', async () => {
    const { org, auth, user } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const task = await createTask(owner, { name: 'test-records Abandoned draft' })
    const stale = await seedFile(org.id, task.id, `comment-draft:${user.id}`, 2)
    const fresh = await seedFile(org.id, task.id, `comment-draft:${user.id}`)
    const posted = await seedFile(org.id, task.id, `comment:${randomUUID()}`, 2)

    await $fetch('/api/_test/records-comment-drafts', { method: 'POST' })
    expect(await fieldKeyOf(stale)).toBeNull()
    expect(await fieldKeyOf(fresh)).not.toBeNull()
    expect(await fieldKeyOf(posted)).not.toBeNull()
  })

  it('takes images only, from people who can comment', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const kim = await addRecordsMember(sql, org.id)
    const task = await createTask(owner, { name: 'test-records Private' })
    const upload = (opts: Opts, type: string, name: string) => {
      const body = new FormData()
      body.append('file', new Blob(['not an image'], { type }), name)
      return $fetch(`/api/records/entries/task/${task.id}/comment-images`, { method: 'POST', body, ...opts })
    }

    await expect(upload(owner, 'text/html', 'page.html')).rejects.toMatchObject({ statusCode: 400 })
    await expect(upload(withOrgHeader(kim.auth, org.slug), 'image/png', 'shot.png')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('comment mentions', () => {
  it('tells someone newly mentioned in a comment, only when they can open the record', async () => {
    const { org, auth, user } = await createRecordsOrgWith(sql, ['member'])
    const owner = withOrgHeader(auth, org.slug)
    const sam = await addRecordsMember(sql, org.id)
    const kim = await addRecordsMember(sql, org.id)
    const at = (id: string, name: string) => `[@ id="${id}" label="${name}"]`
    const notificationsFor = (userId: string) => sql<Array<{ title: string, body: string | null, link: string }>>`
      SELECT title, body, link FROM notifications WHERE user_id = ${userId} ORDER BY created_at`

    // Sam is assigned (one notification), so can open the task; Kim can't.
    const task = await createTask(owner, { name: 'test-records Plan the launch', assignee: [sam.user.id] })
    const body = `- Ask ${at(sam.user.id, 'Sam')}\n- and ${at(kim.user.id, 'Kim')}, cc ${at(user.id, 'Me')}`
    const posted = await comment(owner, task.id, body)

    const sent = await notificationsFor(sam.user.id)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({
      title: `${user.display_name} mentioned you in a comment on a task`,
      body: 'test-records Plan the launch',
      link: `/records/task/${task.id}`
    })
    expect(await notificationsFor(kim.user.id)).toHaveLength(0)
    expect(await notificationsFor(user.id)).toHaveLength(0)

    // An edit that keeps the mention tells nobody again.
    await $fetch(`/api/records/comments/${posted.id}`, { method: 'PATCH', body: { body: `${body}\n\nThanks.` }, ...owner })
    expect(await notificationsFor(sam.user.id)).toHaveLength(2)
  })
})
