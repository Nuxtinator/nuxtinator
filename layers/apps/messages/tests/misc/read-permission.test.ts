// Every messages read route requires messages.read.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupMessagesTestData,
  createMessagesOrgWith,
  addMessagesMember,
  createTestChannel,
  createTestItem,
  withOrgHeader
} from '../helpers'

describe('messages read permission', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupMessagesTestData(sql)
  })

  it('a member without messages.read gets 403 on every read route', async () => {
    const { org, user } = await createMessagesOrgWith(sql, ['admin'])
    const ch = await createTestChannel(sql, { org_id: org.id, created_by: user.id })
    const item = await createTestItem(sql, { org_id: org.id, conversation_id: ch.id, author_id: user.id, body_md: 'banana' })
    const roleless = await addMessagesMember(sql, org.id, [])
    const member = await addMessagesMember(sql, org.id, ['member'])

    const reads: Array<[string, string]> = [
      ['GET', '/api/messages/conversations'],
      ['GET', `/api/messages/conversations/${ch.id}/items`],
      ['GET', `/api/messages/items/${item.id}/comments`],
      ['GET', '/api/messages/search?q=banana'],
      ['GET', '/api/messages/mentions'],
      ['GET', '/api/messages/org-users'],
      ['GET', '/api/messages/tags'],
      ['POST', `/api/messages/conversations/${ch.id}/read`],
      ['POST', `/api/messages/conversations/${ch.id}/subscribe`],
      ['POST', `/api/messages/items/${item.id}/star`]
    ]
    for (const [method, path] of reads) {
      const err = await $fetch(path, { method, ...withOrgHeader(roleless.auth, org.slug) }).catch(e => e)
      expect(err.statusCode, `${method} ${path}`).toBe(403)
    }
    const ok = await $fetch<{ channels: Array<{ id: string }> }>('/api/messages/conversations', withOrgHeader(member.auth, org.slug))
    expect(ok.channels.map(c => c.id)).toContain(ch.id)
  })
})
