// Merged channel-type catalog — code registrations ⊳ crm_channel_types rows.
// Built on core's `defineSettings` (see CLAUDE.md → "Settings pattern"): code
// is the source of truth for what exists, the DB stores admin-created types
// and label overrides. Rows are org-scoped by RLS through the caller's
// tenant transaction, so every call re-reads.

import type { Selectable } from 'kysely'
import { defineSettings, type DbClient } from '#core/server/utils/settings'
import type { Database } from '#core/server/database/schema'
import { getRegisteredChannelTypes, type CrmChannelTypeEntry } from './crm-registry'
import type { ChannelValueFormat } from '../database/schema.d'

type ChannelTypeRow = Selectable<Database['crm_channel_types']>

export interface CrmChannelTypeSetting {
  typeKey: string
  label: string
  icon?: string
  valueFormat: ChannelValueFormat
  config: Record<string, unknown>
  /** True for admin-created channel types (a row with no code registration). */
  custom: boolean
}

export const getChannelTypes = defineSettings<CrmChannelTypeEntry, ChannelTypeRow, CrmChannelTypeSetting>({
  loadDefaults: () => getRegisteredChannelTypes(),
  loadOverrides: async (tx) => {
    const rows = await tx.selectFrom('crm_channel_types').selectAll().execute()
    return new Map(rows.map(r => [r.type_key, r]))
  },
  keyOf: t => t.typeKey,
  merge: (entry, row) => {
    if (entry) {
      return {
        typeKey: entry.typeKey,
        label: row?.label ?? entry.label,
        icon: entry.icon,
        // value_format is code-owned for code-registered types; a row's
        // format only matters for admin-created ones.
        valueFormat: entry.valueFormat,
        config: row?.config ?? {},
        custom: false
      }
    }
    const r = row!
    return {
      typeKey: r.type_key,
      label: r.label ?? r.type_key,
      icon: undefined,
      valueFormat: r.value_format ?? 'freeform',
      config: r.config,
      custom: true
    }
  },
  includeOrphans: true
})

export async function getChannelType(tx: DbClient, typeKey: string): Promise<CrmChannelTypeSetting | null> {
  const all = await getChannelTypes(tx)
  return all.find(t => t.typeKey === typeKey) ?? null
}
