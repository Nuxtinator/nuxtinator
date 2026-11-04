// Insights + progress aggregation endpoints.
//
//   GET /api/list-of-100/insights?window=30d|all
//   GET /api/list-of-100/progress
//
// Both endpoints are scoped to the caller's own data (user_id = ctx.userId).
// The 30d window pads missing days with zeros so the chart x-axis is
// continuous; the `all` window only emits days that have events.
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

describe('GET /api/list-of-100/insights', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('defaults window to 30d and pads with 30 entries — one per day', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const res = await $fetch<{ window: string, series: { day: string, contacted: number, prayed: number }[] }>(
      '/api/list-of-100/insights',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.window).toBe('30d')
    expect(res.series.length).toBe(30)
    // All zero — no events yet.
    expect(res.series.every(p => p.contacted === 0 && p.prayed === 0)).toBe(true)
  })

  it('aggregates rhythm events by day for the 30d window, scoped to the caller', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    // Two events today, one ~5d ago, one ~40d ago (outside the 30d window).
    const today = new Date()
    const fiveAgo = new Date(); fiveAgo.setUTCDate(fiveAgo.getUTCDate() - 5)
    const fortyAgo = new Date(); fortyAgo.setUTCDate(fortyAgo.getUTCDate() - 40)

    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: today })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_PRAYED', timestamp: today })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: fiveAgo })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: fortyAgo })

    const res = await $fetch<{ series: { day: string, contacted: number, prayed: number }[] }>(
      '/api/list-of-100/insights?window=30d',
      { ...withOrgHeader(auth, org.slug) }
    )

    const todayStr = new Date().toISOString().slice(0, 10)
    const fiveAgoStr = fiveAgo.toISOString().slice(0, 10)
    const fortyAgoStr = fortyAgo.toISOString().slice(0, 10)

    const todayPt = res.series.find(p => p.day === todayStr)
    const fiveAgoPt = res.series.find(p => p.day === fiveAgoStr)
    expect(todayPt).toBeTruthy()
    expect(todayPt!.contacted).toBe(1)
    expect(todayPt!.prayed).toBe(1)
    expect(fiveAgoPt!.contacted).toBe(1)
    expect(fiveAgoPt!.prayed).toBe(0)

    // 40-day-ago event was filtered out of the 30d window.
    expect(res.series.some(p => p.day === fortyAgoStr)).toBe(false)
  })

  it('does not include events from other users (same org)', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['member'])
    const theirs = await createTestContact(sql, { user_id: other.user.id })
    await createTestRhythmEvent(sql, { user_id: other.user.id, record_id: theirs.id, event_type: 'MARK_CONTACTED' })

    const res = await $fetch<{ series: { contacted: number, prayed: number }[] }>(
      '/api/list-of-100/insights',
      { ...withOrgHeader(auth, org.slug) }
    )
    const total = res.series.reduce((s, p) => s + p.contacted + p.prayed, 0)
    expect(total).toBe(0)
  })

  it('returns the all-time window without padding (only days with events)', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const c = await createTestContact(sql, { user_id: user.id })

    const longAgo = new Date('2024-06-01T10:00:00Z')
    const veryLongAgo = new Date('2023-11-15T10:00:00Z')

    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_CONTACTED', timestamp: longAgo })
    await createTestRhythmEvent(sql, { user_id: user.id, record_id: c.id, event_type: 'MARK_PRAYED', timestamp: veryLongAgo })

    const res = await $fetch<{ window: string, series: { day: string, contacted: number, prayed: number }[] }>(
      '/api/list-of-100/insights?window=all',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.window).toBe('all')
    expect(res.series.length).toBe(2)
    // Sorted ascending.
    expect(res.series[0]!.day < res.series[1]!.day).toBe(true)
  })

  it('returns 401 with no auth cookie', async () => {
    const { org } = await createListOf100OrgWith(sql, ['admin'])
    const err = await $fetch('/api/list-of-100/insights', {
      headers: { 'x-active-org': org.slug }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })
})

describe('GET /api/list-of-100/progress', () => {
  const sql = getHostAdminDb()
  afterEach(async () => { await cleanupListOf100TestData(sql) })

  it('returns total / contactedLast30d / prayedLast30d scoped to the caller', async () => {
    const { org, user, auth } = await createListOf100OrgWith(sql, ['admin'])
    const recent = new Date(); recent.setUTCDate(recent.getUTCDate() - 5)
    const old = new Date(); old.setUTCDate(old.getUTCDate() - 60)

    await createTestContact(sql, { user_id: user.id, last_contacted_at: recent })
    await createTestContact(sql, { user_id: user.id, last_contacted_at: recent, last_prayed_at: recent })
    await createTestContact(sql, { user_id: user.id, last_contacted_at: old })

    const res = await $fetch<{ total: number, contactedLast30d: number, prayedLast30d: number }>(
      '/api/list-of-100/progress',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res.total).toBe(3)
    expect(res.contactedLast30d).toBe(2)
    expect(res.prayedLast30d).toBe(1)
  })

  it('returns zeros for a user with no contacts', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const res = await $fetch<{ total: number, contactedLast30d: number, prayedLast30d: number }>(
      '/api/list-of-100/progress',
      { ...withOrgHeader(auth, org.slug) }
    )
    expect(res).toEqual({ total: 0, contactedLast30d: 0, prayedLast30d: 0 })
  })

  it('does not count other users\' contacts in the same org', async () => {
    const { org, auth } = await createListOf100OrgWith(sql, ['admin'])
    const other = await addListOf100Member(sql, org.id, ['member'])
    await createTestContact(sql, { user_id: other.user.id })
    await createTestContact(sql, { user_id: other.user.id })

    const res = await $fetch<{ total: number }>('/api/list-of-100/progress', {
      ...withOrgHeader(auth, org.slug)
    })
    expect(res.total).toBe(0)
  })
})
