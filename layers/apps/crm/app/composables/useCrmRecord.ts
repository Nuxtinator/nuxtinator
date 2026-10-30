// Detail state for one record: hydrated fetch plus an optimistic
// patchFields helper that applies the change locally, PATCHes, and rolls
// back to the previous snapshot if the server rejects it.

import type { MaybeRefOrGetter } from 'vue'

/**
 * The caller's server-evaluated capabilities for one record. canEdit is the
 * type-level update answer OR an edit-level share on this record; canShare
 * and canDelete are type-level. Per-type role-grant rows make client-side
 * slug checks unreliable — these flags are the only truthful source.
 */
export interface CrmRecordCapabilities {
  canEdit: boolean
  canShare: boolean
  canDelete: boolean
}

/** Record detail as served by GET/POST/PATCH /api/crm/records/:type[/:id]. */
export interface CrmRecordDetail {
  id: string
  typeKey: string
  name: string
  status: string | null
  /** Hydrated values keyed by field key — includes name and status. */
  fields: Record<string, unknown>
  createdAt: string
  updatedAt: string
  createdBy: string
  /** The linked user account; its name and email addresses are read-only here. */
  userId: string | null
  /** Channel types whose addresses come from the linked account (empty when unlinked). */
  accountOwnedChannelTypes: string[]
  capabilities: CrmRecordCapabilities
}

export function useCrmRecord(typeKey: MaybeRefOrGetter<string>, id: MaybeRefOrGetter<string>) {
  const record = ref<CrmRecordDetail | null>(null)
  const pending = ref(false)
  const error = ref<string | null>(null)

  const url = () => `/api/crm/records/${toValue(typeKey)}/${toValue(id)}`

  async function refresh(): Promise<void> {
    if (!toValue(typeKey) || !toValue(id)) return
    pending.value = true
    try {
      record.value = await $fetch<CrmRecordDetail>(url())
      error.value = null
    } catch (err) {
      error.value = crmErrorMessage(err, 'Failed to load record')
    } finally {
      pending.value = false
    }
  }

  /**
   * PATCHes { fields: partial } with an optimistic local update. Scalar
   * values land in `fields` (and mirror onto name/status when those keys
   * are patched); the server response then replaces the whole record, so
   * multi-value list payloads self-correct on success. Throws on failure
   * after rolling back — callers surface the error (e.g. a toast).
   */
  async function patchFields(partial: Record<string, unknown>): Promise<CrmRecordDetail> {
    const prev = record.value
    if (prev) {
      record.value = {
        ...prev,
        fields: { ...prev.fields, ...partial },
        name: 'name' in partial ? String(partial.name ?? '') : prev.name,
        status: 'status' in partial ? (partial.status as string | null) : prev.status
      }
    }
    try {
      const res = await $fetch<CrmRecordDetail>(url(), {
        method: 'PATCH',
        body: { fields: partial }
      })
      record.value = res
      return res
    } catch (err) {
      record.value = prev
      throw err
    }
  }

  watch(
    () => [toValue(typeKey), toValue(id)],
    () => {
      refresh()
    },
    { immediate: true }
  )

  return { record, pending, error, refresh, patchFields }
}
