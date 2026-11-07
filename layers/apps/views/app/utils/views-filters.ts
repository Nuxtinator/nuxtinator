// Filter builder helpers: the fields a tab can filter on, the empty rule for
// a field and operator, whether a tree is complete enough to save, and the
// values a new record needs to match a filter.
import {
  isRecordsFilterGroup,
  RECORDS_FILTER_INTRINSIC_KINDS,
  RECORDS_FILTER_ME,
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

const LIST_KINDS = new Set(['multi_select', 'tags', 'connection'])
const PREFILL_SKIP = new Set(['name', 'created_at', 'updated_at'])

/**
 * Field values a new record needs to match the given filters: one value for
 * each rule that pins its field (is, any of, all of, on, is empty), read
 * through "all" groups and single-rule "any" groups. Later filters win on
 * single-value fields; list fields collect every pinned value.
 */
export function viewsFilterPrefill(
  filters: Array<RecordsFilterGroup | null | undefined>,
  fields: RecordsFieldSetting[],
  userId: string | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const apply = (rule: RecordsFilterRule) => {
    if (PREFILL_SKIP.has(rule.field)) return
    const def = fields.find(f => !f.orphan && (f.key === rule.field || f.column === rule.field))
    if (!def || def.column === 'name') return
    const resolve = (v: unknown) => def.kind === 'user_select' && v === RECORDS_FILTER_ME ? userId : v
    const list = LIST_KINDS.has(def.kind) || (def.kind === 'user_select' && !!def.multiple)
    const values = Array.isArray(rule.value) ? rule.value.map(resolve) : [resolve(rule.value)]
    if (values.some(v => v === null || v === undefined)) return
    let pinned: unknown[]
    switch (rule.op) {
      case 'is':
      case 'eq':
      case 'on':
        pinned = values
        break
      case 'any_of':
        pinned = values.slice(0, 1)
        break
      case 'all_of':
        pinned = values
        break
      case 'empty':
        if (!list) out[def.key] = null
        return
      default:
        return
    }
    if (!list) {
      out[def.key] = pinned[0]
      return
    }
    const current = Array.isArray(out[def.key]) ? out[def.key] as unknown[] : []
    out[def.key] = [...new Set([...current, ...pinned])]
  }
  const walk = (group: RecordsFilterGroup) => {
    if (group.match === 'any' && group.rules.length !== 1) return
    for (const node of group.rules) {
      if (isRecordsFilterGroup(node)) walk(node)
      else apply(node)
    }
  }
  for (const filter of filters) if (filter) walk(filter)
  return out
}
