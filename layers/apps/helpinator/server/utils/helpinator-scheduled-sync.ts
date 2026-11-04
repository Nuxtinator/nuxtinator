// Scheduled re-sync of website libraries. Portfolio libraries need none: the
// bot reads their sections live. Website sources are crawled snapshots, so a
// sweep re-crawls every source whose last run started more than `maxAgeDays`
// ago. Keying on the source's own age (not on the cron slot) means a slot
// missed while the server was down is caught up on the next sweep, and a
// source synced by hand mid-week isn't crawled again until it is due.
//
// Every due source across every org runs one after another (one crawl at a
// time), through the same run machinery as the "Sync all" button.
import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { withAdvisoryLock } from '#core/server/utils/advisory-lock'
import { isMigrationHeldBack } from '#core/server/utils/migration-status'
import { isAppEnabledForCurrentOrg } from '#tenant/server'
import { helpinatorScopeTx, helpinatorStartSourceSync, helpinatorExpireStaleRuns } from './helpinator-crawl'
import type { HelpinatorSourceRow } from './helpinator-libraries'

// Cross-replica gate key — committed, distinct from core's 84100723915584200xx
// and inbox's 72039140827165300xx families.
export const HELPINATOR_SYNC_SWEEP_LOCK_KEY = '6120483759174620011'

function isTenancyMode(): boolean {
  try {
    const cfg = useRuntimeConfig()
    const paths = (cfg.tenancyMigrationPaths as string[] | undefined) ?? []
    return paths.length > 0
  } catch {
    return false
  }
}

async function listOrgScopes(): Promise<(string | null)[]> {
  if (!isTenancyMode()) return [null]
  // Raw SQL — `orgs` is a tenancy-only table not in core's Kysely schema.
  // Suspended orgs serve no answers, so they get no crawls (or embedding costs).
  const res = await sql<{ id: string }>`select id from orgs where suspended_at is null`.execute(db)
  return res.rows.map(r => r.id)
}

// A sweep crawls every due source in turn, so it can run for hours; the lock
// anchor's idle allowance (see core's withAdvisoryLock) is sized to match.
// Losing the lock mid-run is harmless: a sweep marks all its sources
// 'syncing' up front, so an overlapping sweep finds nothing due.
const SYNC_LOCK_STALE_AFTER_MS = 3 * 60 * 60 * 1000

export async function helpinatorWithSyncLock(fn: () => Promise<void>): Promise<void> {
  await withAdvisoryLock(HELPINATOR_SYNC_SWEEP_LOCK_KEY, { scope: 'helpinator', label: 'library sync', staleAfterMs: SYNC_LOCK_STALE_AFTER_MS }, fn)
}

// Start a sync for every due website source and wait for them all to finish.
// Returns how many were started.
export async function helpinatorSyncDueSources(maxAgeDays: number): Promise<number> {
  // Held back = no pgvector, so none of helpinator's tables exist.
  if (await isMigrationHeldBack('helpinator')) return 0
  let chain: Promise<void> = Promise.resolve()
  let started = 0
  for (const orgId of await listOrgScopes()) {
    try {
      const due = await helpinatorScopeTx(orgId, async (tx) => {
        // An org that turned the app off gets no crawls (or embedding costs).
        if (!await isAppEnabledForCurrentOrg(tx, 'helpinator')) return []
        await helpinatorExpireStaleRuns(tx)
        return await tx
          .selectFrom('helpinator_library_sources as s')
          .innerJoin('helpinator_libraries as l', 'l.id', 's.library_id')
          .selectAll('s')
          .where('l.kind', '=', 'website')
          .where('s.status', '!=', 'syncing')
          .where(eb => eb.or([
            eb(sql`coalesce(s.run_started_at, s.last_synced_at)`, 'is', null),
            eb(sql`coalesce(s.run_started_at, s.last_synced_at)`, '<', sql`now() - ${maxAgeDays}::float8 * interval '1 day'`)
          ]))
          .orderBy('s.created_at')
          .execute() as HelpinatorSourceRow[]
      })
      for (const source of due) {
        // One short tx per source, so each run token commits before its crawl starts.
        const run = await helpinatorScopeTx(orgId, tx => helpinatorStartSourceSync(tx, orgId, source, { after: chain }))
        chain = run.done
        started++
      }
      if (due.length) console.log(`[helpinator] scheduled sync (org ${orgId ?? 'single'}): ${due.length} source(s) queued`)
    } catch (err) {
      console.error(`[helpinator] scheduled sync error (org ${orgId ?? 'single'}):`, err)
    }
  }
  await chain
  return started
}
