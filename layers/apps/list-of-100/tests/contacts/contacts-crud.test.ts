// CRUD endpoints for List of 100 contacts.
//
//   POST   /api/list-of-100/contacts
//   GET    /api/list-of-100/contacts
//   PATCH  /api/list-of-100/contacts/:id
//   DELETE /api/list-of-100/contacts/:id
//
// The handlers gate on `list-of-100.write` (CRUD) / `list-of-100.read` (GET),
// then enforce owner-only visibility by filtering `where user_id = ctx.userId`.
// A non-owner targeting another user's contact gets 404 (the row is invisible
// to their query, not "permission denied").
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupListOf100TestData,
  createListOf100OrgWith,
  addListOf100Member,
  createTestContact,
  withOrgHeader
} from '../helpers'

describe('POST /api/list-of-100/contacts', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('creates a contact on the caller\'s list; DB row matches input', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])

    const res = await $fetch<{ contact: { id: string, name: string, user_id: string } }>(
      '/api/list-of-100/contacts',
      {
        method: 'POST',
        body: {
          name: 'Alice',
          relationship: 'friend',
          faith_status: 'unknown',
          notes: 'met at conference'
        },
        ...withOrgHeader(auth, org.slug)
      }
    )
    expect(res.contact.id).toBeDefined()
    expect(res.contact.user_id).toBe(user.id)

    const rows = await sql<{ name: string, relationship: string, faith_status: string, notes: string | null, user_id: string }[]>`
      SELECT name, relationship, faith_status, notes, user_id
      FROM list_of_100_contacts WHERE id = ${res.contact.id}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.name).toBe('Alice')
    expect(rows[0]!.relationship).toBe('friend')
    expect(rows[0]!.faith_status).toBe('unknown')
    expect(rows[0]!.notes).toBe('met at conference')
    expect(rows[0]!.user_id).toBe(user.id)
  })

  it('trims the name and defaults notes to null when omitted', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const res = await $fetch<{ contact: { id: string, name: string, notes: string | null } }>(
      '/api/list-of-100/contacts',
      {
        method: 'POST',
        body: { name: '  Bob  ', relationship: 'family', faith_status: 'believer' },
        ...withOrgHeader(auth, org.slug)
      }
    )
    expect(res.contact.name).toBe('Bob')
    expect(res.contact.notes).toBeNull()
  })

  it('logs a CREATE activity row for the new contact', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const res = await $fetch<{ contact: { id: string } }>('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'Cara', relationship: 'neighbor', faith_status: 'believer' },
      ...withOrgHeader(auth, org.slug)
    })

    const logs = await sql<{ event_type: string, record_id: string }[]>`
      SELECT event_type, record_id FROM activity_logs
      WHERE table_name = 'list_of_100_contacts'
        AND record_id = ${res.contact.id}
        AND user_id = ${user.id}
    `
    expect(logs.length).toBeGreaterThanOrEqual(1)
    expect(logs.map(l => l.event_type)).toContain('CREATE')
  })

  it('rejects empty name with 400', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: '   ', relationship: 'friend', faith_status: 'unknown' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('rejects invalid relationship enum with 400', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'X', relationship: 'nemesis', faith_status: 'unknown' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('rejects invalid faith_status enum with 400', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'X', relationship: 'friend', faith_status: 'maybe' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 401 when the auth cookie is missing', async () => {
    const { org } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'X', relationship: 'friend', faith_status: 'unknown' },
      headers: { 'x-active-org': org.slug }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('returns 404 when caller isn\'t a member of the active org (tenancy gate)', async () => {
    const a = await createListOf100OrgWith(sql, ['admin'])
    const b = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      method: 'POST',
      body: { name: 'X', relationship: 'friend', faith_status: 'unknown' },
      ...withOrgHeader(a.auth, b.org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('GET /api/list-of-100/contacts', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('returns only the caller\'s contacts, never another user\'s in the same org', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['member'])

    const mine = await createTestContact(sql, { user_id: user.id, name: 'Mine' })
    await createTestContact(sql, { user_id: other.user.id, name: 'Theirs' })

    const res = await $fetch<{ contacts: { id: string, name: string }[], progress: { total: number } }>(
      '/api/list-of-100/contacts',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.contacts.map(c => c.id)).toEqual([mine.id])
    expect(res.progress.total).toBe(1)
  })

  it('returns inline progress counts with contacted/prayed windows', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const old = new Date(); old.setUTCDate(old.getUTCDate() - 60)
    const recent = new Date(); recent.setUTCDate(recent.getUTCDate() - 5)

    await createTestContact(sql, { user_id: user.id, name: 'NoActivity' })
    await createTestContact(sql, { user_id: user.id, name: 'RecentContact', last_contacted_at: recent })
    await createTestContact(sql, { user_id: user.id, name: 'OldContact', last_contacted_at: old })
    await createTestContact(sql, { user_id: user.id, name: 'RecentPray', last_prayed_at: recent })

    const res = await $fetch<{ progress: { total: number, contactedLast30d: number, prayedLast30d: number } }>(
      '/api/list-of-100/contacts',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.progress.total).toBe(4)
    expect(res.progress.contactedLast30d).toBe(1)
    expect(res.progress.prayedLast30d).toBe(1)
  })

  it('orders contacts by sort_order then name', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    await createTestContact(sql, { user_id: user.id, name: 'Charlie', sort_order: 5 })
    await createTestContact(sql, { user_id: user.id, name: 'Alpha', sort_order: 10 })
    await createTestContact(sql, { user_id: user.id, name: 'Beta', sort_order: 10 })

    const res = await $fetch<{ contacts: { name: string }[] }>('/api/list-of-100/contacts', {
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.contacts.map(c => c.name)).toEqual(['Charlie', 'Alpha', 'Beta'])
  })

  it('returns 401 when no auth cookie is present', async () => {
    const { org } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts', {
      headers: { 'x-active-org': org.slug }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })
})

describe('PATCH /api/list-of-100/contacts/:id', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('updates partial fields, refreshes updated_at, leaves others untouched', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, {
      user_id: user.id, name: 'Original', relationship: 'friend', faith_status: 'unknown', notes: 'first'
    })

    const before = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM list_of_100_contacts WHERE id = ${c.id}
    `

    // Small sleep so updated_at advances measurably.
    await new Promise(r => setTimeout(r, 25))

    const res = await $fetch<{ contact: { name: string, faith_status: string, notes: string | null, relationship: string } }>(
      `/api/list-of-100/contacts/${c.id}`,
      {
        method: 'PATCH',
        body: { faith_status: 'believer', notes: 'updated note' },
        ...withOrgHeader(auth, org.slug)
      }
    )
    expect(res.contact.faith_status).toBe('believer')
    expect(res.contact.notes).toBe('updated note')
    expect(res.contact.name).toBe('Original')
    expect(res.contact.relationship).toBe('friend')

    const after = await sql<{ updated_at: Date }[]>`
      SELECT updated_at FROM list_of_100_contacts WHERE id = ${c.id}
    `
    expect(after[0]!.updated_at.getTime()).toBeGreaterThan(before[0]!.updated_at.getTime())
  })

  it('allows nulling notes via explicit null', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id, notes: 'something' })

    const res = await $fetch<{ contact: { notes: string | null } }>(
      `/api/list-of-100/contacts/${c.id}`,
      { method: 'PATCH', body: { notes: null }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.contact.notes).toBeNull()
  })

  it('rejects empty patch body with 400', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })
    const err = await $fetch(`/api/list-of-100/contacts/${c.id}`, {
      method: 'PATCH', body: {}, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('rejects invalid enum with 400', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })
    const err = await $fetch(`/api/list-of-100/contacts/${c.id}`, {
      method: 'PATCH', body: { faith_status: 'wat' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it('returns 404 when targeting a contact owned by another user (owner-only)', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['admin'])
    const theirs = await createTestContact(sql, { user_id: other.user.id, name: 'Theirs' })

    // Caller is an org admin but doesn't own this contact — should still 404.
    const err = await $fetch(`/api/list-of-100/contacts/${theirs.id}`, {
      method: 'PATCH', body: { name: 'Hijacked' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)

    // Row in DB is unchanged.
    const rows = await sql<{ name: string }[]>`SELECT name FROM list_of_100_contacts WHERE id = ${theirs.id}`
    expect(rows[0]!.name).toBe('Theirs')
  })

  it('returns 404 for a contact id that does not exist', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000', {
      method: 'PATCH', body: { name: 'X' }, ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})

describe('DELETE /api/list-of-100/contacts/:id', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('hard-deletes the caller\'s own row; row is gone in DB', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    const res = await $fetch<{ ok: boolean }>(`/api/list-of-100/contacts/${c.id}`, {
      method: 'DELETE', ...withOrgHeader(auth, org.slug)
    })
    expect(res.ok).toBe(true)

    const rows = await sql<{ id: string }[]>`SELECT id FROM list_of_100_contacts WHERE id = ${c.id}`
    expect(rows.length).toBe(0)
  })

  it('returns 404 when targeting a contact owned by another user; row survives', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['member'])
    const theirs = await createTestContact(sql, { user_id: other.user.id })

    const err = await $fetch(`/api/list-of-100/contacts/${theirs.id}`, {
      method: 'DELETE', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)

    const rows = await sql<{ id: string }[]>`SELECT id FROM list_of_100_contacts WHERE id = ${theirs.id}`
    expect(rows.length).toBe(1)
  })

  it('returns 404 for an unknown contact id', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/contacts/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE', ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(err.statusCode).toBe(404)
  })
})
