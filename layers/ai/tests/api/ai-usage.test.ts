// The org spend endpoint: org.settings.write gating, period/feature/daily
// totals over `ai_usage`, and isolation — another org's rows and a user's
// personal-app rows never count toward an org's spend. Rows are seeded
// directly; the VITEST fake makes no provider calls, so it records none.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { getHostAdminDb, getAppUserDb, createAiOrg, createAiOrgMember, cleanupAiTestData } from '../helpers'

interface Totals { cost: number, calls: number, unpriced: number }
interface Summary {
  month: Totals
  lastMonth: Totals
  allTime: Totals
  monthByFeature: (Totals & { feature: string, label: string })[]
  daily: (Totals & { day: string })[]
}

const sql = getHostAdminDb()

async function getUsage(opts: object): Promise<Summary> {
  return $fetch<Summary>('/api/ai/org/usage', { ...opts })
}

async function seed(row: { org_id: string | null, user_id?: string | null, feature: string, cost: number | null, created_at?: string }) {
  await sql`
    INSERT INTO ai_usage (org_id, user_id, feature, model, provider, key_source, prompt_tokens, completion_tokens, cost, created_at)
    VALUES (${row.org_id}, ${row.user_id ?? null}, ${row.feature}, 'test/alpha', 'openrouter', 'host', 10, 5, ${row.cost},
      ${sql.unsafe(row.created_at ?? 'now()')})
  `
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
    expect(usage.monthByFeature).toEqual([])
    expect(usage.daily).toHaveLength(30)
    expect(usage.daily.every(d => d.calls === 0)).toBe(true)
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
    expect(usage.monthByFeature.map(f => [f.feature, f.cost, f.calls, f.unpriced])).toEqual([
      ['test.draft', 0.75, 2, 0],
      ['test.summary', 0, 1, 1]
    ])
    expect(usage.daily.at(-1)).toMatchObject({ cost: 0.75, calls: 3, unpriced: 1 })
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
