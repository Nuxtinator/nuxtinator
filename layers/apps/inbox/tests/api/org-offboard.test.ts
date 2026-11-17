// Org offboarding: deleting an org via the host-admin endpoint removes the
// org's inbox S3 objects (attachment blobs + raw inbound MIME) through the
// `org.deleted` hook, then cascades the rows. Also pins the endpoint's
// guards: slug confirmation and host-admin-only access.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  createOperatorAdmin,
  postInbound,
  s3ObjectExists
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function sender(): string {
  return `test-inbox-${randomUUID().slice(0, 8)}@sender.example`
}

// Seed an org holding both kinds of private S3 objects: an inbound message
// with archived raw MIME, and a draft attachment blob.
async function seedOrgWithS3Objects() {
  const { org, opts, domain, auth } = await createInboxOrgWith(sql)
  const res = await postInbound({ recipient: `hello@${domain}`, from: `P <${sender()}>` })
  const convId = res.body.conversation_id as string

  const draft = await $fetch<{ id: string }>(`/api/inbox/conversations/${convId}/messages`, {
    method: 'POST', body: { saveDraft: true, body: '<p>doomed</p>' }, ...opts
  })
  const fd = new FormData()
  fd.append('draftId', draft.id)
  fd.append('file', new Blob([Buffer.from('attachment bytes')], { type: 'application/pdf' }), 'doomed.pdf')
  await $fetch(`/api/inbox/conversations/${convId}/attachments`, { method: 'POST', body: fd, ...opts })

  const rawKeys = await sql`
    SELECT raw_s3_key FROM inbox_messages
    WHERE org_id = ${org.id} AND raw_s3_key IS NOT NULL
  `
  const attKeys = await sql`
    SELECT a.s3_key FROM inbox_attachments a
    JOIN inbox_messages m ON m.id = a.message_id
    WHERE m.org_id = ${org.id}
  `
  const keys = [
    ...rawKeys.map(r => r.raw_s3_key as string),
    ...attKeys.map(r => r.s3_key as string)
  ]
  return { org, auth, keys }
}

describe('org offboarding S3 cleanup', () => {
  it('deletes the org, its rows, and its S3 objects (raw MIME + attachments)', async () => {
    const { org, keys } = await seedOrgWithS3Objects()
    expect(keys.length).toBeGreaterThanOrEqual(2)
    for (const key of keys) {
      expect(await s3ObjectExists(key), `${key} should exist before delete`).toBe(true)
    }

    const { auth: adminAuth } = await createOperatorAdmin(sql, { email: `test-inbox-${randomUUID().slice(0, 8)}@example.com` })
    const res = await $fetch<{ deleted: boolean }>(`/api/admin/orgs/${org.id}`, {
      method: 'DELETE', body: { confirm: org.slug }, ...adminAuth
    })
    expect(res.deleted).toBe(true)

    const orgRows = await sql`SELECT id FROM orgs WHERE id = ${org.id}`
    expect(orgRows).toHaveLength(0)
    const msgRows = await sql`SELECT id FROM inbox_messages WHERE org_id = ${org.id}`
    expect(msgRows).toHaveLength(0)

    for (const key of keys) {
      expect(await s3ObjectExists(key), `${key} should be gone after delete`).toBe(false)
    }
  })

  it('refuses the delete when the slug confirmation is missing or wrong', async () => {
    const { org } = await seedOrgWithS3Objects()
    const { auth: adminAuth } = await createOperatorAdmin(sql, { email: `test-inbox-${randomUUID().slice(0, 8)}@example.com` })

    await expect(
      $fetch(`/api/admin/orgs/${org.id}`, { method: 'DELETE', body: { confirm: 'wrong-slug' }, ...adminAuth })
    ).rejects.toMatchObject({ statusCode: 400 })

    const orgRows = await sql`SELECT id FROM orgs WHERE id = ${org.id}`
    expect(orgRows).toHaveLength(1)
  })

  it('forbids a non-host-admin from deleting an org', async () => {
    const { org, auth } = await seedOrgWithS3Objects()
    await expect(
      $fetch(`/api/admin/orgs/${org.id}`, { method: 'DELETE', body: { confirm: org.slug }, ...auth })
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
