import { sql } from 'kysely'
import type { AiDbClient } from '#core/ai-fallback/types'
import { db } from '#core/server/utils/database'
import type { AiProvider } from '../../types/ai-ext'
import type { AiUsageSummary, AiUsageTotals } from '../../app/utils/ai-manifest'
import type { AiUsageTable } from '../database/schema'
import { getAiFeatures } from './ai-feature-registry'
import { tokenCount, usageCost, type AiModelPrices, type AiRawUsage } from './ai-usage-cost'

export type AiKeySource = AiUsageTable['key_source']

// The feature key embedding calls are logged under: embedding runs serve a
// scope's vector indexes, not one feature.
export const AI_USAGE_EMBEDDING_FEATURE = 'ai.embedding'

// Who a run's calls are billed to, read when the run is resolved so calls made
// after the caller's transaction has committed are still attributed.
export interface AiUsageScope {
  orgId: string | null
  userId: string | null
  feature: string
  keySource: AiKeySource
}

export interface AiUsageRecord {
  model: string
  provider: AiProvider
  usage: AiRawUsage | null
  prices: AiModelPrices | undefined
}

// The org (`app.current_org`) and user (`app.current_user`) the caller's
// transaction runs as; a personal app's calls have a user and no org.
export async function readUsageScope(tx: AiDbClient, feature: string, keySource: AiKeySource): Promise<AiUsageScope> {
  const res = await sql<{ org: string | null, user: string | null }>`
    select nullif(current_setting('app.current_org', true), '') as org,
           nullif(current_setting('app.current_user', true), '') as user
  `.execute(tx)
  return { orgId: res.rows[0]?.org ?? null, userId: res.rows[0]?.user ?? null, feature, keySource }
}

// Runs are handed back by consumers as plain objects, so their usage scope
// rides alongside them here rather than on the shared run type.
const runScopes = new WeakMap<object, AiUsageScope>()

export function attachUsageScope<R extends object>(run: R, scope: AiUsageScope): R {
  runScopes.set(run, scope)
  return run
}

export function usageScopeOf(run: object): AiUsageScope | undefined {
  return runScopes.get(run)
}

// Logs one round trip against the scope's org and user. Written in its own
// transaction so a call is counted even when the caller's rolls back, and not
// awaited so it never waits on a pool connection the caller is holding.
export function recordUsage(scope: AiUsageScope | undefined, rec: AiUsageRecord): void {
  const fail = (err: unknown) => console.error(`[ai] usage not recorded: ${(err as Error)?.message ?? err}`)
  if (!scope) {
    fail(new Error(`no usage scope for a ${rec.model} run (resolve runs with resolveAiRun / resolveAiEmbedRun)`))
    return
  }
  void db.transaction().execute(async (t) => {
    if (scope.orgId) await sql`select set_config('app.current_org', ${scope.orgId}, true)`.execute(t)
    if (scope.userId) await sql`select set_config('app.current_user', ${scope.userId}, true)`.execute(t)
    await t.insertInto('ai_usage').values({
      user_id: scope.userId,
      feature: scope.feature,
      model: rec.model,
      provider: rec.provider,
      key_source: scope.keySource,
      prompt_tokens: tokenCount(rec.usage?.prompt_tokens),
      completion_tokens: tokenCount(rec.usage?.completion_tokens),
      cost: usageCost(rec.usage, rec.prices)
    }).execute()
  }).catch(fail)
}

const DAILY_DAYS = 30

interface TotalsRow {
  cost: string | null
  calls: string
  unpriced: string
}

function totals(row: TotalsRow | undefined): AiUsageTotals {
  return {
    cost: Number(row?.cost ?? 0),
    calls: Number(row?.calls ?? 0),
    unpriced: Number(row?.unpriced ?? 0)
  }
}

// The active org's spend: this calendar month, last month and all time, this
// month by feature, and each of the last 30 days, oldest first (days and
// months in the database's time zone).
export async function getUsageSummary(tx: AiDbClient): Promise<AiUsageSummary> {
  const periods = await sql<{ period: string } & TotalsRow>`
    select p.period, sum(u.cost) as cost, count(u.id) as calls, count(u.id) filter (where u.cost is null) as unpriced
    from (values
      ('month', date_trunc('month', now()), null::timestamptz),
      ('last_month', date_trunc('month', now()) - interval '1 month', date_trunc('month', now())),
      ('all', null::timestamptz, null::timestamptz)
    ) as p(period, from_at, to_at)
    left join ai_usage u
      on (p.from_at is null or u.created_at >= p.from_at)
      and (p.to_at is null or u.created_at < p.to_at)
    group by p.period
  `.execute(tx)
  const byPeriod = new Map(periods.rows.map(r => [r.period, r]))

  const features = await sql<{ feature: string } & TotalsRow>`
    select feature, sum(cost) as cost, count(*) as calls, count(*) filter (where cost is null) as unpriced
    from ai_usage
    where created_at >= date_trunc('month', now())
    group by feature
    order by sum(cost) desc nulls last, count(*) desc
  `.execute(tx)
  const labels = new Map<string, string>([
    [AI_USAGE_EMBEDDING_FEATURE, 'Embeddings (search indexes)'],
    ...getAiFeatures().map(f => [f.key, f.label] as [string, string])
  ])

  const days = await sql<{ day: string } & TotalsRow>`
    select to_char(d, 'YYYY-MM-DD') as day, sum(u.cost) as cost, count(u.id) as calls, count(u.id) filter (where u.cost is null) as unpriced
    from generate_series(date_trunc('day', now()) - make_interval(days => ${DAILY_DAYS - 1}), date_trunc('day', now()), interval '1 day') as d
    left join ai_usage u on u.created_at >= d and u.created_at < d + interval '1 day'
    group by d
    order by d
  `.execute(tx)

  return {
    month: totals(byPeriod.get('month')),
    lastMonth: totals(byPeriod.get('last_month')),
    allTime: totals(byPeriod.get('all')),
    monthByFeature: features.rows.map(r => ({ feature: r.feature, label: labels.get(r.feature) ?? r.feature, ...totals(r) })),
    daily: days.rows.map(r => ({ day: r.day, ...totals(r) }))
  }
}
