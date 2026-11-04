// Settings pattern. One way to retrieve any setting that combines
// code-declared defaults with DB-stored overrides.
//
// Inspiration: WordPress's `apply_filters(...)` + `get_option(...)` shape used
// throughout Disciple.Tools' `get_post_field_settings`. Each call follows the
// same three-step pipeline:
//
//   1. Code declares the defaults (a layer's Nitro plugin pushes into a
//      registry, or any function that returns a list).
//   2. The DB is consulted for overrides — a typed table indexed by the
//      same key as the defaults.
//   3. The two are merged entry-by-entry. Registry is the iteration driver
//      (so an entry that exists in code but has no DB row still appears,
//      using its declared defaults). DB rows that don't match a registered
//      default ("orphans") can optionally be tacked on at the end — used by
//      host-admin pages that need to surface stale catalog rows.
//
// Every settings surface in the app (apps catalog, per-org app overlay,
// roles, …) should be built by calling `defineSettings({...})` rather than
// hand-rolling the merge. This guarantees every read site agrees on
// iteration order, fallback semantics, and the "DB never resurrects, code
// always wins on existence" rule that the apps-catalog issue identified
// as the root cause of admin/launcher disagreement.
//
// See CLAUDE.md → "Settings pattern" for the full write-up.

import type { Transaction, Kysely } from 'kysely'
import type { Database } from '#core/server/database/schema'

export type DbClient = Kysely<Database> | Transaction<Database>

export interface SettingsContext {
  orgId?: string
  userId?: string
}

export interface DefineSettingsSpec<TDefault, TOverride, TResult> {
  // Returns the iteration set. Usually wraps a registry's `getRegistered*()`
  // call (pure code, no tx needed) but can also be the result of another
  // `defineSettings` reader — two-tier surfaces (e.g. per-org apps =
  // catalog merge then org overlay) compose by passing the inner reader
  // here. That's why this function receives `(tx, ctx)`: defaults built
  // from a previous merge need DB access too.
  loadDefaults: (tx: DbClient, ctx: SettingsContext) => TDefault[] | Promise<TDefault[]>

  // Returns the DB-stored overrides as a Map keyed by the same string used
  // for `keyOf`.
  loadOverrides: (tx: DbClient, ctx: SettingsContext) => Promise<Map<string, TOverride>>

  // Pulls the join key out of a default entry. Why not assume `.id`? Each
  // registry uses its own identity field — apps have `id`, roles have `key`,
  // nav items use composite keys. Explicit is cheaper than coercing every
  // registry to the same field name.
  keyOf: (d: TDefault) => string

  // Combines one default with its (possibly absent) override into the final
  // shape. Both sides are optional: when `includeOrphans` is true the
  // function additionally receives `(undefined, override)` for DB rows
  // without a matching default. The function MUST handle that case if the
  // caller opts in.
  merge: (d: TDefault | undefined, o: TOverride | undefined) => TResult

  // When true, DB overrides without a matching default are included in the
  // result by calling `merge(undefined, override)`. Default false — the
  // common case (per-org filtering, launcher feeds) only wants registered
  // entries. Host-admin catalog pages opt in so stale rows are visible and
  // purgeable.
  includeOrphans?: boolean
}

export type SettingsReader<TResult>
  = (tx: DbClient, ctx?: SettingsContext) => Promise<TResult[]>

export function defineSettings<TDefault, TOverride, TResult>(
  spec: DefineSettingsSpec<TDefault, TOverride, TResult>
): SettingsReader<TResult> {
  return async (tx: DbClient, ctx: SettingsContext = {}): Promise<TResult[]> => {
    const [defaults, overrides] = await Promise.all([
      spec.loadDefaults(tx, ctx),
      spec.loadOverrides(tx, ctx)
    ])

    const usedKeys = new Set<string>()
    const merged = defaults.map((d) => {
      const key = spec.keyOf(d)
      usedKeys.add(key)
      return spec.merge(d, overrides.get(key))
    })

    if (!spec.includeOrphans) return merged

    const orphans: TResult[] = []
    for (const [key, override] of overrides) {
      if (usedKeys.has(key)) continue
      orphans.push(spec.merge(undefined, override))
    }
    return [...merged, ...orphans]
  }
}
