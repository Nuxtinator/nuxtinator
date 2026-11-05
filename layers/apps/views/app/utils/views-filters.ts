// Filter builder helpers: the fields a tab can filter on, the empty rule for
// a field and operator, and whether a tree is complete enough to save.
import {
  isRecordsFilterGroup,
  RECORDS_FILTER_INTRINSIC_KINDS,
  RECORDS_FILTER_VALUE_SHAPE,
  recordsFilterOps
} from '#records'
import type {
  RecordsFieldSetting,
  RecordsFilterGroup,
  RecordsFilterOp,
  RecordsFilterRule
} from '#records/client'

export interface ViewsFilterField {
  key: string
  label: string
  kind: string
  options: RecordsFieldSetting['options']
  target: string | null
}

const INTRINSIC_LABELS: Record<string, string> = {
  name: 'Name',
  status: 'Status',
  created_at: 'Created',
  updated_at: 'Updated'
}

/** Every field a filter can name: the record's own columns, then the type's fields. */
export function viewsFilterFields(fields: RecordsFieldSetting[]): ViewsFilterField[] {
  const out: ViewsFilterField[] = []
  for (const key of Object.keys(RECORDS_FILTER_INTRINSIC_KINDS)) {
    const declared = fields.find(f => f.key === key || f.column === key)
    out.push({
      key,
      label: declared?.label ?? INTRINSIC_LABELS[key]!,
      kind: declared?.kind ?? RECORDS_FILTER_INTRINSIC_KINDS[key]!,
      options: declared?.options ?? null,
      target: null
    })
  }
  for (const field of fields) {
    if (field.hidden || field.orphan || field.column || out.some(f => f.key === field.key)) continue
    if (recordsFilterOps(field.kind).length === 0) continue
    out.push({ key: field.key, label: field.label, kind: field.kind, options: field.options, target: field.target })
  }
  return out
}

/** A rule for `field` with `op` and that op's empty value. */
export function viewsEmptyRule(field: string, op: RecordsFilterOp, kind: string): RecordsFilterRule {
  switch (RECORDS_FILTER_VALUE_SHAPE[op]) {
    case 'none': return { field, op }
    case 'list': return { field, op, value: [] }
    case 'range': return { field, op, value: ['', ''] }
    default: return { field, op, value: kind === 'boolean' ? true : '' }
  }
}

function ruleComplete(rule: RecordsFilterRule): boolean {
  const filled = (v: unknown) => v !== undefined && v !== null && v !== ''
  switch (RECORDS_FILTER_VALUE_SHAPE[rule.op]) {
    case 'none': return true
    case 'list': return Array.isArray(rule.value) && rule.value.length > 0
    case 'range': return Array.isArray(rule.value) && rule.value.length === 2 && rule.value.every(filled)
    default: return filled(rule.value)
  }
}

/** Every rule has its value, and no group is empty. */
export function viewsFilterComplete(group: RecordsFilterGroup): boolean {
  return group.rules.every(node => isRecordsFilterGroup(node)
    ? node.rules.length > 0 && viewsFilterComplete(node)
    : ruleComplete(node))
}
