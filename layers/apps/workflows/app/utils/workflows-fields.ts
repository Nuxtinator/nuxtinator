// The client field settings carry kind + promoted-column flag but not the
// storage class; renderers need it to know which values the list feed can
// actually show. Derived through CRM's own storageOf so the routing table
// lives in one place.
import { storageOf } from '#crm'
import type { CrmStorage } from '#crm'
import type { CrmFieldSetting } from '../../../crm/app/utils/field-kinds'

export function workflowsFieldStorage(field: Pick<CrmFieldSetting, 'kind' | 'column'>): CrmStorage {
  return storageOf({ kind: field.kind, column: field.column ?? undefined })
}
