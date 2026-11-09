// The filter tree: a group of rules and nested groups, each group matching
// all or any of its children. The records list engine compiles it
// (`RecordsListOpts.where`) and the views filter builder edits it. Rules
// address a record's own fields; `@me` in a people rule means whoever is
// looking. The operator catalog below decides which operators each field
// kind offers, on the server and in the builder alike.

export type RecordsFilterOp =
  | 'is'
  | 'is_not'
  | 'any_of'
  | 'none_of'
  | 'all_of'
  | 'contains'
  | 'empty'
  | 'not_empty'
  | 'before'
  | 'after'
  | 'on'
  | 'between'
  | 'eq'
  | 'lt'
  | 'gt'

export interface RecordsFilterRule {
  field: string
  op: RecordsFilterOp
  /** A scalar for single-value ops, a list for any/none/all of, [from, to] for between. */
  value?: unknown
}

export interface RecordsFilterGroup {
  match: 'all' | 'any'
  rules: RecordsFilterNode[]
}

export type RecordsFilterNode = RecordsFilterRule | RecordsFilterGroup

/** In a people rule's value: the person viewing. */
export const RECORDS_FILTER_ME = '@me'

/** Groups nest at most this deep below the top-level group. */
export const RECORDS_FILTER_MAX_DEPTH = 1

export function isRecordsFilterGroup(node: RecordsFilterNode): node is RecordsFilterGroup {
  return 'rules' in node
}

export const RECORDS_FILTER_OP_LABELS: Record<RecordsFilterOp, string> = {
  is: 'is',
  is_not: 'is not',
  any_of: 'is any of',
  none_of: 'is none of',
  all_of: 'has all of',
  contains: 'contains',
  empty: 'is empty',
  not_empty: 'is not empty',
  before: 'is before',
  after: 'is after',
  on: 'is on',
  between: 'is between',
  eq: 'equals',
  lt: 'is less than',
  gt: 'is greater than'
}

// What each op's value is: none, one value, a list, or a [from, to] pair.
export type RecordsFilterValueShape = 'none' | 'single' | 'list' | 'range'

export const RECORDS_FILTER_VALUE_SHAPE: Record<RecordsFilterOp, RecordsFilterValueShape> = {
  is: 'single',
  is_not: 'single',
  any_of: 'list',
  none_of: 'list',
  all_of: 'list',
  contains: 'single',
  empty: 'none',
  not_empty: 'none',
  before: 'single',
  after: 'single',
  on: 'single',
  between: 'range',
  eq: 'single',
  lt: 'single',
  gt: 'single'
}

/** Filterable record columns every type has, whatever its fields. */
export const RECORDS_FILTER_INTRINSIC_KINDS: Record<string, 'text' | 'key_select' | 'datetime'> = {
  name: 'text',
  status: 'key_select',
  created_at: 'datetime',
  updated_at: 'datetime'
}

/** The operators a field of `kind` offers, in the order the builder lists them. */
export function recordsFilterOps(kind: string): RecordsFilterOp[] {
  switch (kind) {
    case 'text':
    case 'textarea':
      return ['contains', 'is', 'empty', 'not_empty']
    case 'key_select':
      return ['is', 'is_not', 'any_of', 'none_of', 'empty', 'not_empty']
    case 'multi_select':
    case 'tags':
      return ['any_of', 'all_of', 'none_of', 'empty', 'not_empty']
    case 'link':
      return ['contains', 'empty', 'not_empty']
    case 'user_select':
      return ['is', 'any_of', 'none_of', 'empty', 'not_empty']
    case 'date':
    case 'datetime':
      return ['on', 'before', 'after', 'between', 'empty', 'not_empty']
    case 'number':
      return ['eq', 'lt', 'gt', 'between', 'empty', 'not_empty']
    case 'boolean':
      return ['is']
    case 'connection':
      return ['any_of', 'none_of', 'empty', 'not_empty']
    case 'communication_channel':
      return ['contains', 'empty', 'not_empty']
    case 'attachments':
      return ['empty', 'not_empty']
    case 'ref':
      return ['is', 'is_not', 'empty', 'not_empty']
    default:
      return []
  }
}

/** The number of rules in a tree, counting into groups. */
export function recordsFilterRuleCount(group: RecordsFilterGroup | null | undefined): number {
  if (!group) return 0
  let n = 0
  for (const node of group.rules) n += isRecordsFilterGroup(node) ? recordsFilterRuleCount(node) : 1
  return n
}
