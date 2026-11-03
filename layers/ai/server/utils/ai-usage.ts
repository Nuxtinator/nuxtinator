import { sql, type RawBuilder } from 'kysely'
import type { AiDbClient } from '#core/ai-fallback/types'
import { db } from '#core/server/utils/database'
import { getRegisteredApp } from '#core/server/utils/app-registry'
import type { AiProvider } from '../../types/ai-ext'
import type { AiUsageBreakdowns, AiUsageCalls, AiUsageGroup, AiUsagePeriod, AiUsageSummary, AiUsageTotals } from '../../app/utils/ai-manifest'
import type { AiUsageTable } from '../database/schema'
import { getAiFeatures } from './ai-feature-registry'
import { tokenCount, usageCost, type AiModelPrices, type AiRawUsage } from './ai-usage-cost'
import { usageSubjectLabels } from './ai-usage-subjects'

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
  // What inside the feature the run is for, as `<prefix>:<id>` (see ai-usage-subjects).
  subject: string | null
}

export interface AiUsageRecord {
  model: string
  provider: AiProvider
  usage: AiRawUsage | null
  prices: AiModelPrices | undefined
}

// The org (`app.current_org`) and user (`app.current_user`) the caller's
// transaction runs as; a personal app's calls have a user and no org.
export async function readUsageScope(tx: AiDbClient, feature: string, keySource: AiKeySource, subject: string | null = null): Promise<AiUsageScope> {
  const res = await sql<{ org: string | null, user: string | null }>`
    select nullif(current_setting('app.current_org', true), '') as org,
           nullif(current_setting('app.current_user', true), '') as user
  `.execute(tx)
  return { orgId: res.rows[0]?.org ?? null, userId: res.rows[0]?.user ?? null, feature, keySource, subject: subject || null }
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
      subject: scope.subject,
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
const CALLS_PAGE = 50

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

function addTotals(into: AiUsageTotals, t: AiUsageTotals): void {
  into.cost += t.cost
  into.calls += t.calls
  into.unpriced += t.unpriced
}

// Whose spend a summary covers: the org (or personal user) the transaction
// runs as, read through RLS; or the whole deployment, read through the
// `ai_usage_host_daily` function, with orgs broken out when tenancy is loaded.
export type AiUsageView = { kind: 'org' } | { kind: 'host', orgs: boolean }

// `ai_usage` summed per day, org, user, feature, subject, model and key source, from
// `from` on (everything when null) — the same rows in both views.
function dailySource(view: AiUsageView, from: RawBuilder<unknown> | null) {
  if (view.kind === 'host') return sql`ai_usage_host_daily(${from ?? sql`null`})`
  return sql`(
    select date_trunc('day', created_at) as day, null::uuid as org_id, user_id, feature, subject, model, key_source,
           sum(cost) as cost, count(*) as calls, count(*) filter (where cost is null) as unpriced
    from ai_usage
    ${from ? sql`where created_at >= ${from}` : sql``}
    group by 1, 3, 4, 5, 6, 7
  )`
}

const PERIOD_BOUNDS: Record<AiUsagePeriod, { from: RawBuilder<unknown> | null, to: RawBuilder<unknown> | null }> = {
  month: { from: sql`date_trunc('month', now())`, to: null },
  last_month: { from: sql`date_trunc('month', now()) - interval '1 month'`, to: sql`date_trunc('month', now())` },
  '30d': { from: sql`date_trunc('day', now()) - make_interval(days => ${DAILY_DAYS - 1})`, to: null },
  all: { from: null, to: null }
}

// The layer a feature belongs to: the namespace of its key ('inbox.draft' → 'inbox').
export function usageLayerOf(feature: string): string {
  return feature.split('.')[0] || feature
}

function layerLabel(layer: string): string {
  if (layer === usageLayerOf(AI_USAGE_EMBEDDING_FEATURE)) return 'Layer not recorded'
  return getRegisteredApp(layer)?.title ?? layer
}

function featureLabels(): Map<string, string> {
  return new Map<string, string>([
    [AI_USAGE_EMBEDDING_FEATURE, 'Embeddings (layer not recorded)'],
    ...getAiFeatures().map(f => [f.key, f.label] as [string, string])
  ])
}

const KEY_SOURCE_LABELS: Record<AiKeySource, string> = {
  org: 'Organization\'s key',
  host: 'Host key'
}

const NO_USER_LABEL = 'No signed-in user'
const NO_ORG_LABEL = 'Personal apps'

async function userLabels(tx: AiDbClient, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await tx.selectFrom('users').select(['id', 'display_name', 'email']).where('id', 'in', ids).execute()
  return new Map(rows.map(r => [r.id, r.display_name || r.email || r.id]))
}

async function orgLabels(tx: AiDbClient, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await sql<{ id: string, name: string }>`select id, name from orgs where id in (${sql.join(ids)})`.execute(tx)
  return new Map(rows.rows.map(r => [r.id, r.name]))
}

function sortGroups(groups: Iterable<AiUsageGroup>): AiUsageGroup[] {
  return [...groups].sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.label.localeCompare(b.label))
}

// Sums rows into one group per `keyOf`, labelled by `labelOf`.
function groupBy<R extends AiUsageTotals>(rows: R[], keyOf: (r: R) => string, labelOf: (key: string) => string): AiUsageGroup[] {
  const groups = new Map<string, AiUsageGroup>()
  for (const r of rows) {
    const key = keyOf(r)
    let g = groups.get(key)
    if (!g) groups.set(key, g = { key, label: labelOf(key), cost: 0, calls: 0, unpriced: 0 })
    addTotals(g, r)
  }
  return sortGroups(groups.values())
}

// Spend this calendar month, last month and all time; the period's spend by
// layer, feature, subject, model, user, key source and (host view) org; and each of the
// last 30 days split by layer, oldest first. Days and months are in the
// database's time zone.
export async function getUsageSummary(tx: AiDbClient, view: AiUsageView, period: AiUsagePeriod = 'month'): Promise<AiUsageSummary> {
  const periods = await sql<{ period: string } & TotalsRow>`
    select p.period, sum(u.cost) as cost, coalesce(sum(u.calls), 0) as calls, coalesce(sum(u.unpriced), 0) as unpriced
    from (values
      ('month', date_trunc('month', now()), null::timestamptz),
      ('last_month', date_trunc('month', now()) - interval '1 month', date_trunc('month', now())),
      ('all', null::timestamptz, null::timestamptz)
    ) as p(period, from_at, to_at)
    left join ${dailySource(view, null)} u
      on (p.from_at is null or u.day >= p.from_at)
      and (p.to_at is null or u.day < p.to_at)
    group by p.period
  `.execute(tx)
  const byPeriod = new Map(periods.rows.map(r => [r.period, r]))

  const bounds = PERIOD_BOUNDS[period]
  const combos = await sql<{ org_id: string | null, user_id: string | null, feature: string, subject: string | null, model: string, key_source: AiKeySource } & TotalsRow>`
    select org_id, user_id, feature, subject, model, key_source, sum(cost) as cost, sum(calls) as calls, sum(unpriced) as unpriced
    from ${dailySource(view, bounds.from)} u
    ${bounds.to ? sql`where u.day < ${bounds.to}` : sql``}
    group by 1, 2, 3, 4, 5, 6
  `.execute(tx)
  const rows = combos.rows.map(r => ({ ...r, ...totals(r) }))

  const users = await userLabels(tx, [...new Set(rows.flatMap(r => r.user_id ? [r.user_id] : []))])
  const features = featureLabels()
  const by: AiUsageBreakdowns = {
    layer: groupBy(rows, r => usageLayerOf(r.feature), layerLabel),
    feature: groupBy(rows, r => r.feature, k => features.get(k) ?? k),
    subject: [],
    model: groupBy(rows, r => r.model, k => k),
    user: groupBy(rows, r => r.user_id ?? '', k => k ? users.get(k) ?? k : NO_USER_LABEL),
    keySource: groupBy(rows, r => r.key_source, k => KEY_SOURCE_LABELS[k as AiKeySource] ?? k)
  }
  if (view.kind === 'host' && view.orgs) {
    const orgs = await orgLabels(tx, [...new Set(rows.flatMap(r => r.org_id ? [r.org_id] : []))])
    by.org = groupBy(rows, r => r.org_id ?? '', k => k ? orgs.get(k) ?? k : NO_ORG_LABEL)
  }

  const days = await sql<{ day: string, feature: string | null } & TotalsRow>`
    select to_char(d, 'YYYY-MM-DD') as day, u.feature, sum(u.cost) as cost, coalesce(sum(u.calls), 0) as calls, coalesce(sum(u.unpriced), 0) as unpriced
    from generate_series(date_trunc('day', now()) - make_interval(days => ${DAILY_DAYS - 1}), date_trunc('day', now()), interval '1 day') as d
    left join ${dailySource(view, PERIOD_BOUNDS['30d'].from)} u on u.day = d
    group by d, u.feature
    order by d
  `.execute(tx)
  const daily = new Map<string, AiUsageSummary['daily'][number]>()
  const dayRows: (AiUsageTotals & { layer: string })[] = []
  for (const r of days.rows) {
    let day = daily.get(r.day)
    if (!day) daily.set(r.day, day = { day: r.day, cost: 0, calls: 0, unpriced: 0, layers: {} })
    if (!r.feature) continue
    const t = totals(r)
    const layer = usageLayerOf(r.feature)
    addTotals(day, t)
    day.layers[layer] = (day.layers[layer] ?? 0) + t.cost
    dayRows.push({ layer, ...t })
  }

  // Last: a consumer's resolver runs in this transaction, and one that fails aborts it.
  const subjects = await usageSubjectLabels(tx, rows.map(r => r.subject ?? ''))
  by.subject = groupBy(rows, r => r.subject ?? '', k => subjects.get(k) ?? k)

  return {
    month: totals(byPeriod.get('month')),
    lastMonth: totals(byPeriod.get('last_month')),
    allTime: totals(byPeriod.get('all')),
    period,
    by,
    daily: [...daily.values()],
    dailyLayers: groupBy(dayRows, r => r.layer, layerLabel)
  }
}

// The active org's calls, newest first, a page at a time. `cursor` is the
// `next` of the previous page.
export async function getUsageCalls(tx: AiDbClient, cursor: string | null): Promise<AiUsageCalls> {
  const [at, id] = cursor?.split('|') ?? []
  const rows = await sql<{
    id: string, at: string, feature: string, subject: string | null, model: string, key_source: AiKeySource, user_id: string | null,
    prompt_tokens: number, completion_tokens: number, cost: string | null, cursor: string
  }>`
    select id, created_at as at, feature, subject, model, key_source, user_id, prompt_tokens, completion_tokens, cost,
           created_at::text || '|' || id as cursor
    from ai_usage
    ${at && id ? sql`where (created_at, id) < (${at}::timestamptz, ${id}::uuid)` : sql``}
    order by created_at desc, id desc
    limit ${CALLS_PAGE + 1}
  `.execute(tx)
  const page = rows.rows.slice(0, CALLS_PAGE)
  const users = await userLabels(tx, [...new Set(page.flatMap(r => r.user_id ? [r.user_id] : []))])
  const features = featureLabels()
  const subjects = await usageSubjectLabels(tx, page.map(r => r.subject ?? ''))
  return {
    calls: page.map(r => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      layer: layerLabel(usageLayerOf(r.feature)),
      feature: features.get(r.feature) ?? r.feature,
      subject: subjects.get(r.subject ?? '') ?? r.subject ?? '',
      model: r.model,
      keySource: KEY_SOURCE_LABELS[r.key_source] ?? r.key_source,
      user: r.user_id ? users.get(r.user_id) ?? r.user_id : NO_USER_LABEL,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      cost: r.cost === null ? null : Number(r.cost)
    })),
    next: rows.rows.length > CALLS_PAGE ? page.at(-1)!.cursor : null
  }
}
