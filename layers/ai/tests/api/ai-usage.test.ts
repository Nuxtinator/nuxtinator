// The spend endpoints. Org: org.settings.write gating, period totals,
// breakdowns, the daily split by layer, the recent-calls log, and isolation —
// another org's rows and a user's personal-app rows never count toward an
// org's spend. Host: operator-admin gating and every org's and personal app's
// rows, broken out by org. Rows are seeded directly; the VITEST fake makes no
// provider calls, so it records none.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { getHostAdminDb, getAppUserDb, createAiOrg, createAiOrgMember, cleanupAiTestData } from '../helpers'

interface Totals { cost: number, calls: number, unpriced: number }
type Group = Totals & { key: string, label: string }
interface Summary {
  month: Totals
  lastMonth: Totals
  allTime: Totals
  period: string
  by: { layer: Group[], feature: Group[], model: Group[], user: Group[], keySource: Group[], org?: Group[] }
  daily: (Totals & { day: string, layers: Record<string, number> })[]
  dailyLayers: Group[]
}
interface Calls {
  calls: { id: string, feature: string, model: string, user: string, cost: number | null }[]
  next: string | null
}

const sql = getHostAdminDb()

async function getUsage(opts: object, period?: string): Promise<Summary> {
  return $fetch<Summary>('/api/ai/org/usage', { ...opts, query: period ? { period } : undefined })
}

async function getHostUsage(opts: object, period?: string): Promise<Summary> {
  return $fetch<Summary>('/api/ai/admin/usage', { ...opts, query: period ? { period } : undefined })
}

async function getCalls(opts: object, cursor?: string): Promise<Calls> {
  return $fetch<Calls>('/api/ai/org/usage-calls', { ...opts, query: cursor ? { cursor } : undefined })
}

async function seed(row: {
  org_id: string | null, user_id?: string | null, feature: string, cost: number | null,
  model?: string, key_source?: 'org' | 'host', created_at?: string
}) {
  await sql`
    INSERT INTO ai_usage (org_id, user_id, feature, model, provider, key_source, prompt_tokens, completion_tokens, cost, created_at)
    VALUES (${row.org_id}, ${row.user_id ?? null}, ${row.feature}, ${row.model ?? 'test/alpha'}, 'openrouter', ${row.key_source ?? 'host'}, 10, 5, ${row.cost},
      ${sql.unsafe(row.created_at ?? 'now()')})
  `
}

function totalsOf(groups: Group[] | undefined, key: string): Totals | undefined {
  const g = groups?.find(x => x.key === key)
  return g && { cost: g.cost, calls: g.calls, unpriced: g.unpriced }
}

describe('ai org usage', () => {
  beforeAll(async () => {
    await cleanupAiTestData(sql)
  })
  afterAll(async () => {
    await cleanupAiTestData(sql)
  })

  it('rejects a member without org.settings.write', async () => {
    const { org } = await createAiOrg(sql)
    const member = await createAiOrgMember(sql, org)
    await expect(getUsage(member.opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('starts empty, with 30 zero days ending today', async () => {
    const { opts } = await createAiOrg(sql)
    const usage = await getUsage(opts)
    expect(usage.month).toEqual({ cost: 0, calls: 0, unpriced: 0 })
    expect(usage.allTime).toEqual({ cost: 0, calls: 0, unpriced: 0 })
    expect(usage.period).toBe('month')
    expect(usage.by.layer).toEqual([])
    expect(usage.by.org).toBeUndefined()
    expect(usage.dailyLayers).toEqual([])
    expect(usage.daily).toHaveLength(30)
    expect(usage.daily.every(d => d.calls === 0 && Object.keys(d.layers).length === 0)).toBe(true)
  })

  it('totals the org\'s spend by period, feature and day', async () => {
    const { org, opts } = await createAiOrg(sql)
    await seed({ org_id: org.id, feature: 'test.draft', cost: 0.25 })
    await seed({ org_id: org.id, feature: 'test.draft', cost: 0.5 })
    await seed({ org_id: org.id, feature: 'test.summary', cost: null })
    await seed({ org_id: org.id, feature: 'test.draft', cost: 2, created_at: `date_trunc('month', now()) - interval '1 day'` })

    const usage = await getUsage(opts)
    expect(usage.month).toEqual({ cost: 0.75, calls: 3, unpriced: 1 })
    expect(usage.lastMonth).toEqual({ cost: 2, calls: 1, unpriced: 0 })
    expect(usage.allTime).toEqual({ cost: 2.75, calls: 4, unpriced: 1 })
    expect(usage.by.feature.map(f => [f.key, f.cost, f.calls, f.unpriced])).toEqual([
      ['test.draft', 0.75, 2, 0],
      ['test.summary', 0, 1, 1]
    ])
    expect(usage.daily.at(-1)).toMatchObject({ cost: 0.75, calls: 3, unpriced: 1, layers: { test: 0.75 } })

    const lastMonth = await getUsage(opts, 'last_month')
    expect(lastMonth.period).toBe('last_month')
    expect(lastMonth.by.feature.map(f => [f.key, f.cost, f.calls])).toEqual([['test.draft', 2, 1]])
    expect((await getUsage(opts, 'all')).by.layer.map(l => [l.key, l.cost, l.calls])).toEqual([['test', 2.75, 4]])
  })

  it('breaks the period down by layer, model, user and key source', async () => {
    const { org, user, opts } = await createAiOrg(sql)
    await seed({ org_id: org.id, user_id: user.id, feature: 'alpha.draft', cost: 1, model: 'test/alpha' })
    await seed({ org_id: org.id, feature: 'alpha.summary', cost: 2, model: 'test/beta', key_source: 'org' })
    await seed({ org_id: org.id, feature: 'beta.embeddings', cost: 0.5, model: 'test/beta' })
    await seed({ org_id: org.id, feature: 'ai.embedding', cost: 0.25, model: 'test/beta' })

    const usage = await getUsage(opts)
    expect(usage.by.layer.map(l => [l.key, l.cost])).toEqual([['alpha', 3], ['beta', 0.5], ['ai', 0.25]])
    expect(totalsOf(usage.by.layer, 'ai')).toEqual({ cost: 0.25, calls: 1, unpriced: 0 })
    expect(usage.by.layer.find(l => l.key === 'ai')!.label).toBe('Layer not recorded')
    expect(usage.by.model.map(m => [m.key, m.cost])).toEqual([['test/beta', 2.75], ['test/alpha', 1]])
    expect(totalsOf(usage.by.user, user.id)).toEqual({ cost: 1, calls: 1, unpriced: 0 })
    expect(totalsOf(usage.by.user, '')).toEqual({ cost: 2.75, calls: 3, unpriced: 0 })
    expect(usage.by.keySource.map(k => [k.key, k.cost])).toEqual([['org', 2], ['host', 1.75]])
    expect(usage.dailyLayers.map(l => l.key)).toEqual(['alpha', 'beta', 'ai'])
    expect(usage.daily.at(-1)!.layers).toEqual({ alpha: 3, beta: 0.5, ai: 0.25 })
  })

  it('lists the org\'s calls newest first, a page at a time', async () => {
    const a = await createAiOrg(sql)
    const b = await createAiOrg(sql)
    for (let i = 0; i < 55; i++) {
      await seed({ org_id: a.org.id, feature: 'test.draft', cost: i, created_at: `now() - interval '${i} minutes'` })
    }
    await seed({ org_id: b.org.id, feature: 'test.draft', cost: 99 })

    const first = await getCalls(a.opts)
    expect(first.calls).toHaveLength(50)
    expect(first.calls.map(c => c.cost).slice(0, 3)).toEqual([0, 1, 2])
    expect(first.next).toBeTruthy()
    const second = await getCalls(a.opts, first.next!)
    expect(second.calls.map(c => c.cost)).toEqual([50, 51, 52, 53, 54])
    expect(second.next).toBeNull()

    const member = await createAiOrgMember(sql, a.org)
    await expect(getCalls(member.opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('counts only the active org\'s rows, never another org\'s or a personal app\'s', async () => {
    const a = await createAiOrg(sql)
    const b = await createAiOrg(sql)
    await seed({ org_id: a.org.id, feature: 'test.draft', cost: 1 })
    await seed({ org_id: b.org.id, feature: 'test.draft', cost: 10 })
    await seed({ org_id: null, user_id: a.user.id, feature: 'test.personal', cost: 100 })

    expect((await getUsage(a.opts)).allTime).toEqual({ cost: 1, calls: 1, unpriced: 0 })
    expect((await getUsage(b.opts)).allTime).toEqual({ cost: 10, calls: 1, unpriced: 0 })
  })

  it('shows a personal app\'s rows only to the user who made the calls', async () => {
    const a = await createAiOrg(sql)
    const b = await createAiOrg(sql)
    await seed({ org_id: null, user_id: a.user.id, feature: 'test.personal', cost: 3 })

    const app = getAppUserDb()
    const visibleTo = async (userId: string) => await app.begin(async (tx) => {
      await tx`select set_config('app.current_user', ${userId}, true)`
      return (await tx<{ n: number }[]>`select count(*)::int as n from ai_usage where feature = 'test.personal'`)[0]!.n
    })
    expect(await visibleTo(a.user.id)).toBe(1)
    expect(await visibleTo(b.user.id)).toBe(0)
  })
})

describe('ai host usage', () => {
  beforeAll(async () => {
    await cleanupAiTestData(sql)
  })
  afterAll(async () => {
    await cleanupAiTestData(sql)
  })

  it('rejects anyone but an operator admin', async () => {
    const { opts } = await createAiOrg(sql, { admin: false })
    await expect(getHostUsage(opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('totals every org\'s and personal app\'s spend, by org', async () => {
    const a = await createAiOrg(sql)
    const b = await createAiOrg(sql, { admin: false })
    const before = await getHostUsage(a.auth)
    await seed({ org_id: a.org.id, feature: 'test.draft', cost: 1 })
    await seed({ org_id: b.org.id, feature: 'test.draft', cost: 10 })
    await seed({ org_id: null, user_id: b.user.id, feature: 'test.personal', cost: 100 })

    const usage = await getHostUsage(a.auth)
    expect(usage.month.cost - before.month.cost).toBeCloseTo(111)
    expect(usage.month.calls - before.month.calls).toBe(3)
    expect(totalsOf(usage.by.org, a.org.id)).toEqual({ cost: 1, calls: 1, unpriced: 0 })
    expect(totalsOf(usage.by.org, b.org.id)).toEqual({ cost: 10, calls: 1, unpriced: 0 })
    expect(usage.by.org!.find(o => o.key === a.org.id)!.label).toBe('Test AI Org')
    expect(usage.by.org!.find(o => o.key === '')!.label).toBe('Personal apps')
    expect(totalsOf(usage.by.user, b.user.id)).toEqual({ cost: 100, calls: 1, unpriced: 0 })
  })
})
