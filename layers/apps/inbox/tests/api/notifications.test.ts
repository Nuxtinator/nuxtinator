// Staff-notification targeting: an unassigned new inbound raises a bell-only
// broadcast to everyone with inbox access, upgraded to an immediate email for
// the users named in the notify_user_ids setting; once a conversation has an
// assignee, a contact reply notifies only them with an immediate email; a
// vacation auto-reply notifies nobody; a held (non-vacation) intruder message
// raises the held notice.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupInboxTestData,
  createInboxOrgWith,
  createInboxUser,
  addTestMembership,
  setInboxOrgSetting,
  postInbound
} from '../helpers'

const sql = getHostAdminDb()
afterEach(async () => { await cleanupInboxTestData(sql) })

function uniqueSender(tag: string) {
  return `test-inbox-${tag}-${randomUUID().slice(0, 8)}@sender.example`
}

async function notificationRows(convId: string) {
  return await sql`
    SELECT user_id, title, email_mode FROM notifications WHERE link = ${`/inbox/${convId}`}
  `
}

describe('staff notification targeting', () => {
  it('broadcasts bell-only to inbox users for an unassigned new message', async () => {
    const { user, domain } = await createInboxOrgWith(sql)
    const res = await postInbound({ recipient: `hello@${domain}`, from: `N <${uniqueSender('bcast')}>` })
    const rows = await notificationRows(res.body.conversation_id as string)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => (r.title as string).startsWith('New message from'))).toBe(true)
    expect(rows.every(r => r.email_mode === 'none')).toBe(true)
    expect(rows.map(r => r.user_id)).toContain(user.id)
  })

  it('emails the configured recipients on unassigned mail, bell-only for the rest', async () => {
    const { org, user, domain } = await createInboxOrgWith(sql)
    const other = await createInboxUser(sql)
    await addTestMembership(sql, { user_id: other.id, org_id: org.id, roles: ['admin'] })
    await setInboxOrgSetting(sql, org.id, 'notify_user_ids', [user.id])

    const res = await postInbound({ recipient: `hello@${domain}`, from: `N <${uniqueSender('notify')}>` })
    const rows = await notificationRows(res.body.conversation_id as string)

    const modeByUser = new Map(rows.map(r => [r.user_id, r.email_mode]))
    expect(modeByUser.get(user.id)).toBe('immediate')
    expect(modeByUser.get(other.id)).toBe('none')
  })

  it('skips a configured recipient who has no inbox access', async () => {
    const { org, user, domain } = await createInboxOrgWith(sql)
    // No membership, so no inbox.access — a stale id left in the setting.
    const outsider = await createInboxUser(sql)
    await setInboxOrgSetting(sql, org.id, 'notify_user_ids', [outsider.id, user.id])

    const res = await postInbound({ recipient: `hello@${domain}`, from: `N <${uniqueSender('stale')}>` })
    const rows = await notificationRows(res.body.conversation_id as string)

    expect(rows.map(r => r.user_id)).not.toContain(outsider.id)
    expect(rows.find(r => r.user_id === user.id)?.email_mode).toBe('immediate')
  })

  it('sends the assignee an immediate email on a contact reply', async () => {
    const { org, user, opts, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const sender = uniqueSender('assigned')
    const first = await postInbound({ recipient: `hello@${domain}`, from: `R <${sender}>` })
    const convId = first.body.conversation_id as string

    // Staff reply auto-assigns the replier.
    await $fetch(`/api/inbox/conversations/${convId}/messages`, {
      method: 'POST', body: { body: '<p>on it</p>' }, ...opts
    })
    const [row] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${convId}`
    const reply = await postInbound({
      recipient: `contact+${row!.reply_token}@${domain}`,
      from: `R <${sender}>`,
      subject: 'Re: Test subject'
    })
    expect(reply.body.conversation_id).toBe(convId)

    const rows = (await notificationRows(convId)).filter(r => (r.title as string).startsWith('New reply from'))
    expect(rows.length).toBe(1)
    expect(rows[0]!.user_id).toBe(user.id)
    expect(rows[0]!.email_mode).toBe('immediate')
  })

  it('does not email an assignee who has left the org; the reply goes to the broadcast instead', async () => {
    const { org, user, domain } = await createInboxOrgWith(sql)
    await setInboxOrgSetting(sql, org.id, 'auto_ack_enabled', false)
    const former = await createInboxUser(sql)
    const sender = uniqueSender('former')
    const first = await postInbound({ recipient: `hello@${domain}`, from: `R <${sender}>` })
    const convId = first.body.conversation_id as string
    // Assigned to someone who is no longer a member of the org.
    const [row] = await sql`
      UPDATE inbox_conversations SET assigned_user_id = ${former.id} WHERE id = ${convId} RETURNING reply_token
    `
    await postInbound({
      recipient: `contact+${row!.reply_token}@${domain}`,
      from: `R <${sender}>`,
      subject: 'Re: Test subject'
    })

    const rows = (await notificationRows(convId)).filter(r => (r.title as string).startsWith('New reply from'))
    expect(rows.map(r => r.user_id)).not.toContain(former.id)
    expect(rows.map(r => r.user_id)).toContain(user.id)
  })

  it('never notifies for a vacation auto-reply; a held intruder message raises the held notice', async () => {
    const { domain } = await createInboxOrgWith(sql)
    const sender = uniqueSender('quiet')
    const first = await postInbound({ recipient: `hello@${domain}`, from: `V <${sender}>` })
    const convId = first.body.conversation_id as string
    const [row] = await sql`SELECT reply_token FROM inbox_conversations WHERE id = ${convId}`
    const tokenAddr = `contact+${row!.reply_token}@${domain}`

    const before = (await notificationRows(convId)).length
    await postInbound({
      recipient: tokenAddr,
      from: `V <${sender}>`,
      headers: [['Auto-Submitted', 'auto-replied']]
    })
    expect((await notificationRows(convId)).length).toBe(before)

    const held = await postInbound({ recipient: tokenAddr, from: `M <${uniqueSender('mal')}>` })
    expect(held.body.status).toBe('held')
    const heldRows = (await notificationRows(convId)).filter(r => (r.title as string).startsWith('Held message from'))
    expect(heldRows.length).toBeGreaterThan(0)
  })

  it('opening a conversation marks only the opener\'s notifications for it read', async () => {
    const { org, user, opts, domain } = await createInboxOrgWith(sql)
    const other = await createInboxUser(sql)
    await addTestMembership(sql, { user_id: other.id, org_id: org.id, roles: ['admin'] })
    const opened = await postInbound({ recipient: `hello@${domain}`, from: `A <${uniqueSender('open-a')}>` })
    const untouched = await postInbound({ recipient: `hello@${domain}`, from: `B <${uniqueSender('open-b')}>` })
    const link = `/inbox/${opened.body.conversation_id as string}`

    const res = await $fetch<{ updated: number }>('/api/notifications/read', {
      method: 'POST', body: { links: [link, `${link}?filter=open`] }, ...opts
    })
    expect(res.updated).toBe(1)

    const rows = await sql<{ user_id: string, link: string, read: boolean }[]>`
      SELECT user_id, link, read_at IS NOT NULL AS read FROM notifications
      WHERE link IN (${link}, ${`/inbox/${untouched.body.conversation_id as string}`})
    `
    const read = (userId: string, l: string) => rows.find(r => r.user_id === userId && r.link === l)?.read
    expect(read(user.id, link)).toBe(true)
    expect(read(other.id, link)).toBe(false)
    expect(read(user.id, `/inbox/${untouched.body.conversation_id as string}`)).toBe(false)
  })
})
