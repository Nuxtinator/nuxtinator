// Share-table registry. Each personal app that shares registers its share
// tables at boot, as it registers permissions and nav items. Core reads the
// registry to find the caller's known people, and to turn an accepted share
// invite into shares.
//
// A table made by `createShareTable` (`@nuxtinator/core/share-tables`) has the
// standard columns and its accept-invite function. An older table with its own
// shape registers its column names instead; it takes part in known people but
// not in invite shares.

export interface ShareTableEntry {
  appId: string
  table: string
  // The column naming the person a share is for, and the one naming who
  // shared. Defaults: 'grantee_user_id', 'granted_by'.
  granteeColumn?: string
  grantorColumn?: string
  // True for tables made by `createShareTable`.
  standard?: boolean
}

const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/

const _tables = new Map<string, Required<ShareTableEntry>>()

export function registerShareTable(entry: ShareTableEntry): void {
  const full: Required<ShareTableEntry> = {
    appId: entry.appId,
    table: entry.table,
    granteeColumn: entry.granteeColumn ?? 'grantee_user_id',
    grantorColumn: entry.grantorColumn ?? 'granted_by',
    standard: entry.standard ?? (entry.granteeColumn === undefined && entry.grantorColumn === undefined)
  }
  for (const id of [full.table, full.granteeColumn, full.grantorColumn]) {
    if (!IDENT_RE.test(id)) throw new Error(`[share-registry] invalid identifier "${id}"`)
  }
  _tables.set(full.table, full)
}

export function getShareTables(): Array<Required<ShareTableEntry>> {
  return [..._tables.values()]
}

export function getShareTable(table: string): Required<ShareTableEntry> | null {
  return _tables.get(table) ?? null
}

export function __resetShareRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetShareRegistryForTests is not callable in production')
  }
  _tables.clear()
}
