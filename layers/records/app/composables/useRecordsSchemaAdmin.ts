// Client wrapper for the org-level schema-builder write routes. Every
// successful write refreshes the shared useRecordsTypes cache so navigation,
// lists, and the detail page pick up the new definitions without a reload.
//
// Access: the settings pages gate on `canManage`, which the server derives
// from records.schema.manage and returns on GET /api/records/schema/types —
// there is no client-side permission store to consult, so the flag is the
// server's answer, cached per session.

import type { RecordsCardLayout, RecordsFieldOption } from '#records'
import type { RecordsFieldSetting } from '../utils/field-kinds'
import type { RecordsTypeSummary } from './useRecordsTypes'

export interface RecordsCreateTypeInput {
  typeKey: string
  label: string
  labelSingular: string
  icon?: string
}

/** undefined = untouched; null = revert to the code default (code types). */
export interface RecordsUpdateTypePatch {
  label?: string | null
  labelSingular?: string | null
  icon?: string | null
  hidden?: boolean
  sectionOrder?: string[] | null
  closedReasonField?: string | null
  boardsGrantVisibility?: boolean | null
  card?: RecordsCardLayout | null
}

export interface RecordsCreateFieldInput {
  fieldKey: string
  kind: string
  label: string
  icon?: string
  section?: string
  required?: boolean
  options?: Record<string, RecordsFieldOption>
  /** Kind-specific inputs from a registered kind-settings component (e.g. channelType). */
  [extra: string]: unknown
}

export interface RecordsUpdateFieldPatch {
  label?: string | null
  /** null reverts a manifest field to its code icon / clears a custom one. */
  icon?: string | null
  hidden?: boolean
  required?: boolean | null
  order?: number | null
  section?: string | null
  /** Full desired state per option key; null removes the override/option. */
  options?: Record<string, RecordsFieldOption | null>
  /** Option keys in display order; null reverts to the code order. */
  optionOrder?: string[] | null
}

/** Kinds admins may create, with picker labels (mirrors the server whitelist). */
export const RECORDS_ADMIN_KIND_OPTIONS: Array<{ value: string, label: string }> = [
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
  { value: 'connection', label: 'Connection' },
  // Offered only when a layer registers kind settings for it (crm).
  { value: 'communication_channel', label: 'Channel' }
]

// Display labels for the code-only kinds (not creatable by admins, but they
// appear in manifest field lists).
const EXTRA_KIND_LABELS: Record<string, string> = {
  user_select: 'Users'
}

export function recordsKindLabel(kind: string): string {
  return RECORDS_ADMIN_KIND_OPTIONS.find(k => k.value === kind)?.label
    ?? EXTRA_KIND_LABELS[kind]
    ?? kind
}

/** Field kinds that carry an options vocabulary. */
export const RECORDS_OPTION_KINDS = new Set(['key_select', 'multi_select', 'tags'])

/** Turns a label into a schema slug: 'VIP Level' → 'vip_level'. */
export function recordsSlugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 41)
}

export const RECORDS_SLUG_CLIENT_RE = /^[a-z][a-z0-9_]{1,40}$/

export function useRecordsSchemaAdmin() {
  const { refresh: refreshTypes } = useRecordsTypes()

  // Keyed by the active org (useRecordsOrgKey) — org switching is an SPA
  // navigation, so an unkeyed copy would leak across orgs. A missing key =
  // not yet asked the server for that org.
  const canManageCache = useState<Record<string, boolean>>('records:schema-can-manage', () => ({}))
  const orgKey = useRecordsOrgKey()

  const canManage = computed<boolean | null>(() => canManageCache.value[orgKey.value] ?? null)

  /** Resolves the caller's schema-manage access (cached per org); false on any failure. */
  async function ensureAccess(): Promise<boolean> {
    if (canManage.value === null) {
      // The org is captured before the request so a response that resolves
      // after an org switch lands in the slot it was fetched for.
      const key = orgKey.value
      try {
        const res = await $fetch<{ canManage: boolean }>('/api/records/schema/types')
        canManageCache.value = { ...canManageCache.value, [key]: res.canManage }
      } catch {
        canManageCache.value = { ...canManageCache.value, [key]: false }
      }
    }
    return canManage.value === true
  }

  async function createType(input: RecordsCreateTypeInput): Promise<RecordsTypeSummary> {
    const res = await $fetch<{ type: RecordsTypeSummary }>('/api/records/schema/types', {
      method: 'POST',
      body: input
    })
    await refreshTypes()
    return res.type
  }

  async function updateType(typeKey: string, patch: RecordsUpdateTypePatch): Promise<RecordsTypeSummary> {
    const res = await $fetch<{ type: RecordsTypeSummary }>(`/api/records/schema/types/${typeKey}`, {
      method: 'PATCH',
      body: patch
    })
    await refreshTypes()
    return res.type
  }

  async function deleteType(typeKey: string): Promise<void> {
    await $fetch(`/api/records/schema/types/${typeKey}`, { method: 'DELETE' })
    await refreshTypes()
  }

  async function createField(typeKey: string, input: RecordsCreateFieldInput): Promise<RecordsFieldSetting> {
    const res = await $fetch<{ field: RecordsFieldSetting }>(`/api/records/schema/types/${typeKey}/fields`, {
      method: 'POST',
      body: input
    })
    await refreshTypes()
    return res.field
  }

  async function updateField(
    typeKey: string,
    fieldKey: string,
    patch: RecordsUpdateFieldPatch
  ): Promise<RecordsFieldSetting> {
    const res = await $fetch<{ field: RecordsFieldSetting }>(
      `/api/records/schema/types/${typeKey}/fields/${fieldKey}`,
      { method: 'PATCH', body: patch }
    )
    await refreshTypes()
    return res.field
  }

  async function deleteField(typeKey: string, fieldKey: string): Promise<void> {
    await $fetch(`/api/records/schema/types/${typeKey}/fields/${fieldKey}`, { method: 'DELETE' })
    await refreshTypes()
  }

  /**
   * Persists a new display order. Fields get sequential order values with
   * gaps (10, 20, …); only fields whose current merged order differs from
   * the target are patched — the server additionally drops overrides equal
   * to the code default.
   */
  async function reorderFields(typeKey: string, ordered: RecordsFieldSetting[]): Promise<void> {
    const patches: Array<{ key: string, order: number }> = []
    ordered.forEach((field, index) => {
      const target = (index + 1) * 10
      if (field.order !== target) patches.push({ key: field.key, order: target })
    })
    for (const patch of patches) {
      await $fetch(`/api/records/schema/types/${typeKey}/fields/${patch.key}`, {
        method: 'PATCH',
        body: { order: patch.order }
      })
    }
    if (patches.length > 0) await refreshTypes()
  }

  return {
    canManage,
    ensureAccess,
    createType,
    updateType,
    deleteType,
    createField,
    updateField,
    deleteField,
    reorderFields
  }
}
