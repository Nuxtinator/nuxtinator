// Mark-contacted / mark-prayed / history endpoints.
//
//   POST /api/list-of-100/contacts/:id/mark-contacted
//   POST /api/list-of-100/contacts/:id/mark-prayed
//   GET  /api/list-of-100/contacts/:id/history
//
// The mark-* handlers bump `last_contacted_at` / `last_prayed_at` AND log a
// MARK_CONTACTED / MARK_PRAYED row into `activity_logs` in the same txn.
// History reads those rows back for the contact.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupListOf100TestData,
  createListOf100OrgWith,
  addListOf100Member,
  createTestContact,
  createTestRhythmEvent,
  withOrgHeader
} from '../helpers'

describe('POST /api/list-of-100/contacts/:id/mark-contacted', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('bumps last_contacted_at and writes a MARK_CONTACTED activity row', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id, name: 'Dana' })

    const res = await $fetch<{ contact: { id: string, last_contacted_at: string | null } }>(
      `/api/list-of-100/contacts/${c.id}/mark-contacted`,
      { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )
    expect(res.contact.id).toBe(c.id)
    expect(res.contact.last_contacted_at).not.toBeNull()

    const rows = await sql<{ last_contacted_at: Date | null }[]>`
      SELECT last_contacted_at FROM list_of_100_contacts WHERE id = ${c.id}
    `
    expect(rows[0]!.last_contacted_at).not.toBeNull()

    const logs = await sql<{ event_type: string, metadata: { contact_name?: string } }[]>`
      SELECT event_type, metadata FROM activity_logs
      WHERE table_name = 'list_of_100_contacts'
        AND record_id = ${c.id}
        AND user_id = ${user.id}
        AND event_type = 'MARK_CONTACTED'
    `
    expect(logs.length).toBe(1)
    expect(logs[0]!.metadata.contact_name).toBe('Dana')
  })

  it('returns 404 for a contact owned by someone else (owner-only)', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['admin'])
    const theirs = await createTestContact(sql, { user_id: other.user.id })

    const err = await $fetch(`/api/list-of-100/contacts/${theirs.id}/mark-contacted`, {
      method: 'POST', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)

    // No activity row was written.
    const logs = await sql<{ id: string }[]>`
      SELECT id FROM activity_logs
      WHERE record_id = ${theirs.id} AND event_type = 'MARK_CONTACTED'
    `
    expect(logs.length).toBe(0)
  })

  it('returns 404 for an unknown contact id', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000/mark-contacted', {
      method: 'POST', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('POST /api/list-of-100/contacts/:id/mark-prayed', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('bumps last_prayed_at and writes a MARK_PRAYED activity row', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id, name: 'Eli' })

    const res = await $fetch<{ contact: { last_prayed_at: string | null } }>(
      `/api/list-of-100/contacts/${c.id}/mark-prayed`,
      { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )
    expect(res.contact.last_prayed_at).not.toBeNull()

    const rows = await sql<{ last_prayed_at: Date | null }[]>`
      SELECT last_prayed_at FROM list_of_100_contacts WHERE id = ${c.id}
    `
    expect(rows[0]!.last_prayed_at).not.toBeNull()

    const logs = await sql<{ event_type: string }[]>`
      SELECT event_type FROM activity_logs
      WHERE record_id = ${c.id} AND event_type = 'MARK_PRAYED'
    `
    expect(logs.length).toBe(1)
  })

  it('returns 404 for a contact owned by someone else', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['admin'])
    const theirs = await createTestContact(sql, { user_id: other.user.id })

    const err = await $fetch(`/api/list-of-100/contacts/${theirs.id}/mark-prayed`, {
      method: 'POST', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('GET /api/list-of-100/contacts/:id/history', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('returns the caller\'s MARK_CONTACTED + MARK_PRAYED events for the contact, newest first', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    const oldest = new Date('2025-01-01T10:00:00Z')
    const middle = new Date('2025-02-01T10:00:00Z')
    const newest = new Date('2025-03-01T10:00:00Z')

    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: oldest })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_PRAYED', timestamp: middle })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: newest })

    const res = await $fetch<{ events: { event_type: string, timestamp: string }[] }>(
      `/api/list-of-100/contacts/${c.id}/history`,
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.events.length).toBe(3)
    expect(res.events.map(e => e.event_type)).toEqual(['MARK_CONTACTED', 'MARK_PRAYED', 'MARK_CONTACTED'])
    // Newest first.
    expect(new Date(res.events[0]!.timestamp).getTime()).toBeGreaterThan(new Date(res.events[1]!.timestamp).getTime())
  })

  it('excludes non-mark events for the contact (CREATE / UPDATE etc.)', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    // logCreate-style row.
    await sql`
      INSERT INTO activity_logs (id, timestamp, event_type, table_name, record_id, user_id, metadata)
      VALUES (gen_random_uuid(), now(), 'CREATE', 'list_of_100_contacts', ${c.id}, ${user.id}, '{}'::jsonb)
    `
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_PRAYED' })

    const res = await $fetch<{ events: { event_type: string }[] }>(
      `/api/list-of-100/contacts/${c.id}/history`,
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.events.length).toBe(1)
    expect(res.events[0]!.event_type).toBe('MARK_PRAYED')
  })

  it('returns 404 for a contact owned by another user — even when activity rows exist', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['admin'])
    const theirs = await createTestContact(sql, { user_id: other.user.id })
    await createTestRhythmEvent(sql, { user_id: other.user.id, record_id: theirs.id, event_type: 'MARK_PRAYED' })

    const err = await $fetch(`/api/list-of-100/contacts/${theirs.id}/history`, {
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })

  it('returns an empty array for a contact with no rhythm events', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    const res = await $fetch<{ events: unknown[] }>(`/api/list-of-100/contacts/${c.id}/history`, {
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.events).toEqual([])
  })
})
