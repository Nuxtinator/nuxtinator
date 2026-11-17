// Per-user sending identities: alias/signature management (lowercasing,
// reserved-word + admin gating), /me From resolution, tokenless alias mail
// auto-assigning to the alias owner, and a personal send snapshotting from_email
// while baking in the signature.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  createInboxUser,
  addTestMembership,
  postInbound
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

describe('sending identities', () => {
  it('sets alias + signature, exposes personalFrom, rejects reserved aliases', async () => {
    const { opts, user, domain } = await createInboxOrgWith(sql)
    await $fetch(`/api/inbox/identities/${user.id}`, {
      method: 'PUT', body: { alias: 'Jane', signature: '<p>Best, Jane</p>' }, ...opts
    })
    const me = await $fetch<{ alias: string, personalFrom: string, signature: string }>('/api/inbox/me', opts)
    expect(me.alias).toBe('jane') // lowercased on write
    expect(me.personalFrom).toBe(`jane@${domain}`)
    expect(me.signature).toBe('<p>Best, Jane</p>')

    await expect(
      $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'contact' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 400 })
    // `nx-` local parts belong to the mail kernel's receiving probes.
    await expect(
      $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'nx-probe-abc' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lets a send-capable non-admin edit their signature but not their alias', async () => {
    const { opts, user } = await createInboxOrgWith(sql, ['inbox_agent'])
    await $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { signature: '<p>Hi</p>' }, ...opts })
    await expect(
      $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'bob' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('auto-assigns tokenless alias mail to the alias owner', async () => {
    const { opts, user, domain } = await createInboxOrgWith(sql)
    await $fetch(`/api/inbox/identities/${user.id}`, { method: 'PUT', body: { alias: 'jane' }, ...opts })
    const sender = `test-inbox-${randomUUID().slice(0, 8)}@sender.example`
    const res = await postInbound({ recipient: `jane@${domain}`, from: `X <${sender}>` })
    const convId = res.body.conversation_id as string
    const detail = await $fetch<{ conversation: { assignedUserId: string | null } }>(`/api/inbox/conversations/${convId}`, opts)
    expect(detail.conversation.assignedUserId).toBe(user.id)
  })

  it('lets an admin set a teammate alias, lists it in the manager feed, and audits from/to', async () => {
    const { org, opts } = await createInboxOrgWith(sql)
    const teammate = await createInboxUser(sql)
    await addTestMembership(sql, { user_id: teammate.id, org_id: org.id, roles: ['inbox_agent'] })

    const res = await $fetch<{ userId: string, alias: string | null }>(`/api/inbox/identities/${teammate.id}`, {
      method: 'PUT', body: { alias: 'Support' }, ...opts
    })
    expect(res.alias).toBe('support')

    // The admin manager list surfaces the teammate's alias.
    const list = await $fetch<{ identities: Array<{ userId: string, alias: string | null }> }>('/api/inbox/identities', opts)
    expect(list.identities.find(i => i.userId === teammate.id)?.alias).toBe('support')

    // Change it again — the audit row carries the transition.
    await $fetch(`/api/inbox/identities/${teammate.id}`, { method: 'PUT', body: { alias: 'help' }, ...opts })
    const audit = await sql`
      SELECT metadata FROM activity_logs
      WHERE event_type = 'inbox_identity_updated'
        AND metadata->>'targetUserId' = ${teammate.id}
      ORDER BY timestamp ASC
    `
    expect(audit.length).toBe(2)
    const last = audit[audit.length - 1]!.metadata as { field: string, from: string | null, to: string | null }
    expect(last.field).toBe('alias')
    expect(last.from).toBe('support')
    expect(last.to).toBe('help')

    // The identities manager list itself stays admin-only.
    const agent = await createInboxOrgWith(sql, ['inbox_agent'])
    await expect($fetch('/api/inbox/identities', agent.opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('validates the alias target: non-UUID 400, unknown user 404, non-member and no-access members rejected', async () => {
    const { org, opts } = await createInboxOrgWith(sql)

    // Malformed id → clean 400, not a Postgres cast error surfacing as 500.
    await expect(
      $fetch('/api/inbox/identities/not-a-uuid', { method: 'PUT', body: { alias: 'x' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 400 })

    // Nonexistent user → 404, not a users-FK 500.
    await expect(
      $fetch(`/api/inbox/identities/${randomUUID()}`, { method: 'PUT', body: { alias: 'ghost' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 404 })

    // A user outside the org can't be granted a routable alias.
    const outsider = await createInboxUser(sql)
    await expect(
      $fetch(`/api/inbox/identities/${outsider.id}`, { method: 'PUT', body: { alias: 'outsider' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 400 })

    // Neither can an org member whose roles carry no inbox access.
    const noAccess = await createInboxUser(sql)
    await addTestMembership(sql, { user_id: noAccess.id, org_id: org.id, roles: [] })
    await expect(
      $fetch(`/api/inbox/identities/${noAccess.id}`, { method: 'PUT', body: { alias: 'noaccess' }, ...opts })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('personal send snapshots from_email and appends the signature', async () => {
    const { opts, user, domain } = await createInboxOrgWith(sql)
    await $fetch(`/api/inbox/identities/${user.id}`, {
      method: 'PUT', body: { alias: 'jane', signature: '<p>Best, Jane</p>' }, ...opts
    })
    const sender = `test-inbox-${randomUUID().slice(0, 8)}@sender.example`
    const res = await postInbound({ recipient: `hello@${domain}`, from: `Y <${sender}>` })
    const convId = res.body.conversation_id as string
    await $fetch(`/api/inbox/conversations/${convId}/messages`, {
      method: 'POST', body: { body: '<p>Hello there</p>', fromIdentity: 'personal' }, ...opts
    })
    const detail = await $fetch<{ messages: Array<{ direction: string, fromEmail: string | null, bodyHtml: string | null }> }>(
      `/api/inbox/conversations/${convId}`, opts
    )
    const outbound = detail.messages.find(m => m.direction === 'outbound')!
    expect(outbound.fromEmail).toBe(`jane@${domain}`)
    expect(outbound.bodyHtml).toContain('Best, Jane')
  })
})
