// Client wrapper for the org-level schema-builder write routes, plus the
// merged channel-type catalog. Every successful write refreshes the shared
// useCrmTypes cache so navigation, lists, and the detail page pick up the
// new definitions without a reload.
//
// Access: the settings pages gate on `canManage`, which the server derives
// from crm.schema.manage and returns on GET /api/crm/schema/channel-types —
// there is no client-side permission store to consult, so the flag is the
// server's answer, cached per session.

import type { CrmFieldOption } from '#crm'
import type { CrmFieldSetting } from '../utils/field-kinds'
import type { CrmTypeSummary } from './useCrmTypes'

export type CrmChannelValueFormat = 'email' | 'phone' | 'handle' | 'url' | 'freeform'

/** A channel type as served by GET /api/crm/schema/channel-types. */
export interface CrmChannelTypeSummary {
  key: string
  label: string
  icon: string | null
  valueFormat: CrmChannelValueFormat
  custom: boolean
}

export interface CrmCreateTypeInput {
  typeKey: string
  label: string
  labelSingular: string
  icon?: string
}

/** undefined = untouched; null = revert to the code default (code types). */
export interface CrmUpdateTypePatch {
  label?: string | null
  labelSingular?: string | null
  icon?: string | null
  hidden?: boolean
  sectionOrder?: string[] | null
}

export interface CrmCreateFieldInput {
  fieldKey: string
  kind: string
  label: string
  icon?: string
  section?: string
  required?: boolean
  options?: Record<string, CrmFieldOption>
  /** communication_channel only: the channel-type key the field holds. */
  channelType?: string
}

export interface CrmUpdateFieldPatch {
  label?: string | null
  /** null reverts a manifest field to its code icon / clears a custom one. */
  icon?: string | null
  hidden?: boolean
  required?: boolean | null
  order?: number | null
  section?: string | null
  /** Full desired state per option key; null removes the override/option. */
  options?: Record<string, CrmFieldOption | null>
}

export interface CrmCreateChannelTypeInput {
  typeKey: string
  label: string
  valueFormat: CrmChannelValueFormat
  icon?: string
}

/** Kinds admins may create, with picker labels (mirrors the server whitelist). */
export const CRM_ADMIN_KIND_OPTIONS: Array<{ value: string, label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'key_select', label: 'Dropdown' },
  { value: 'multi_select', label: 'Multi select' },
  { value: 'tags', label: 'Tags' },
  { value: 'link', label: 'Links' },
  { value: 'communication_channel', label: 'Channel' }
]

// Display labels for the code-only kinds (not creatable by admins, but they
// appear in manifest field lists).
const EXTRA_KIND_LABELS: Record<string, string> = {
  user_select: 'Users',
  connection: 'Connection'
}

export function crmKindLabel(kind: string): string {
  return CRM_ADMIN_KIND_OPTIONS.find(k => k.value === kind)?.label
    ?? EXTRA_KIND_LABELS[kind]
    ?? kind
}

/** Field kinds that carry an options vocabulary. */
export const CRM_OPTION_KINDS = new Set(['key_select', 'multi_select', 'tags'])

/** Turns a label into a schema slug: 'VIP Level' → 'vip_level'. */
export function crmSlugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 41)
}

export const CRM_SLUG_CLIENT_RE = /^[a-z][a-z0-9_]{1,40}$/

interface ChannelTypesResponse {
  canManage: boolean
  channelTypes: CrmChannelTypeSummary[]
}

export function useCrmSchemaAdmin() {
  const { refresh: refreshTypes } = useCrmTypes()

  // Both caches are keyed by the active org (useCrmOrgKey) — org switching is
  // an SPA navigation, so an unkeyed copy would leak across orgs. A missing
  // key = not yet asked the server for that org.
  const canManageCache = useState<Record<string, boolean>>('crm:schema-can-manage', () => ({}))
  const channelTypesCache = useState<Record<string, CrmChannelTypeSummary[]>>('crm:schema-channel-types', () => ({}))
  const orgKey = useCrmOrgKey()

  // A host that doesn't offer the schema builder and permissions matrix sets
  // app config `crm.schemaAdmin: false`: the links and pages stay hidden
  // whatever the caller's permissions. The server still checks the permission.
  const schemaAdmin = (useAppConfig() as { crm?: { schemaAdmin?: boolean } }).crm?.schemaAdmin !== false
  const canManage = computed<boolean | null>(() => schemaAdmin ? (canManageCache.value[orgKey.value] ?? null) : false)
  const channelTypes = computed(() => channelTypesCache.value[orgKey.value] ?? [])

  // The org is captured before the request so a response that resolves after
  // an org switch lands in the slot it was fetched for.
  async function loadChannelTypes(): Promise<void> {
    const key = orgKey.value
    const res = await $fetch<ChannelTypesResponse>('/api/crm/schema/channel-types')
    canManageCache.value = { ...canManageCache.value, [key]: res.canManage }
    channelTypesCache.value = { ...channelTypesCache.value, [key]: res.channelTypes }
  }

  /** Resolves the caller's schema-manage access (cached per org); false on any failure. */
  async function ensureAccess(): Promise<boolean> {
    if (canManage.value === null) {
      const key = orgKey.value
      try {
        await loadChannelTypes()
      } catch {
        canManageCache.value = { ...canManageCache.value, [key]: false }
      }
    }
    return canManage.value === true
  }

  async function createType(input: CrmCreateTypeInput): Promise<CrmTypeSummary> {
    const res = await $fetch<{ type: CrmTypeSummary }>('/api/crm/schema/types', {
      method: 'POST',
      body: input
    })
    await refreshTypes()
    return res.type
  }

  async function updateType(typeKey: string, patch: CrmUpdateTypePatch): Promise<CrmTypeSummary> {
    const res = await $fetch<{ type: CrmTypeSummary }>(`/api/crm/schema/types/${typeKey}`, {
      method: 'PATCH',
      body: patch
    })
    await refreshTypes()
    return res.type
  }

  async function deleteType(typeKey: string): Promise<void> {
    await $fetch(`/api/crm/schema/types/${typeKey}`, { method: 'DELETE' })
    await refreshTypes()
  }

  async function createField(typeKey: string, input: CrmCreateFieldInput): Promise<CrmFieldSetting> {
    const res = await $fetch<{ field: CrmFieldSetting }>(`/api/crm/schema/types/${typeKey}/fields`, {
      method: 'POST',
      body: input
    })
    await refreshTypes()
    return res.field
  }

  async function updateField(
    typeKey: string,
    fieldKey: string,
    patch: CrmUpdateFieldPatch
  ): Promise<CrmFieldSetting> {
    const res = await $fetch<{ field: CrmFieldSetting }>(
      `/api/crm/schema/types/${typeKey}/fields/${fieldKey}`,
      { method: 'PATCH', body: patch }
    )
    await refreshTypes()
    return res.field
  }

  async function deleteField(typeKey: string, fieldKey: string): Promise<void> {
    await $fetch(`/api/crm/schema/types/${typeKey}/fields/${fieldKey}`, { method: 'DELETE' })
    await refreshTypes()
  }

  /**
   * Persists a new display order. Fields get sequential order values with
   * gaps (10, 20, …); only fields whose current merged order differs from
   * the target are patched — the server additionally drops overrides equal
   * to the code default.
   */
  async function reorderFields(typeKey: string, ordered: CrmFieldSetting[]): Promise<void> {
    const patches: Array<{ key: string, order: number }> = []
    ordered.forEach((field, index) => {
      const target = (index + 1) * 10
      if (field.order !== target) patches.push({ key: field.key, order: target })
    })
    for (const patch of patches) {
      await $fetch(`/api/crm/schema/types/${typeKey}/fields/${patch.key}`, {
        method: 'PATCH',
        body: { order: patch.order }
      })
    }
    if (patches.length > 0) await refreshTypes()
  }

  async function createChannelType(input: CrmCreateChannelTypeInput): Promise<CrmChannelTypeSummary> {
    const res = await $fetch<{ channelType: CrmChannelTypeSummary }>('/api/crm/schema/channel-types', {
      method: 'POST',
      body: input
    })
    await loadChannelTypes()
    return res.channelType
  }

  async function deleteChannelType(typeKey: string): Promise<void> {
    await $fetch(`/api/crm/schema/channel-types/${typeKey}`, { method: 'DELETE' })
    await loadChannelTypes()
  }

  return {
    canManage,
    channelTypes,
    ensureAccess,
    loadChannelTypes,
    createType,
    updateType,
    deleteType,
    createField,
    updateField,
    deleteField,
    reorderFields,
    createChannelType,
    deleteChannelType
  }
}
