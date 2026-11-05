// Server entry for the `#records/server` alias — the surface consumer layers
// (crm, inbox, views, meetings) import kernel services and extension points
// from.

export {
  registerRecordType,
  registerRecordFieldExtension,
  getRegisteredRecordTypes,
  getRegisteredRecordType,
  registerRecordsFieldFilter,
  runRecordsFieldFilters,
  registerRecordsStorageDriver,
  getRecordsStorageDriver,
  registerRecordsClosingHook,
  registerRecordsPatchGuard,
  runRecordsPatchGuards,
  registerRecordsVisibilitySource
} from '../utils/records-registry'
export type {
  RecordsFieldPatch,
  RecordsFieldFilterPhase,
  RecordsFieldFilter,
  RecordsStorageDriver,
  RecordsListItem,
  RecordsListPatch,
  RecordsFilterCond,
  RecordsFilterHelpers,
  RecordsClosingEvent,
  RecordsClosingHook,
  RecordsPatchGuard,
  RecordsVisibilitySource
} from '../utils/records-registry'

export {
  getRecordTypes,
  getRecordType,
  getRecordTypeFields,
  RECORDS_DEFAULT_PERMISSION_PREFIX
} from '../utils/definition-settings'
export type { RecordTypeSetting, RecordsFieldSetting } from '../utils/definition-settings'

export { normalizeChannelValue, channelFingerprint } from '../utils/normalize'
export type { NormalizedChannelValue } from '../utils/normalize'

export { hydrateRecords, getRecord, applyFieldPatch, deleteRecord } from '../utils/record-storage'
export type { RecordRow, RecordsHydratedRecord } from '../utils/record-storage'

export { permFor, RECORD_ACTIONS } from '../utils/records-perms'
export type { RecordAction, RecordsTypeRoleGrants } from '../utils/records-perms'

export {
  resolveTypePermission,
  resolveTypeCapabilities,
  requireTypePermission,
  canUpdateRecord,
  requireRecordUpdate
} from '../utils/type-permissions'
export type { RecordsTypeCapabilities } from '../utils/type-permissions'

export { listMatrixRoles, buildRoleGrantsView } from '../utils/role-grants-admin'
export type {
  RecordsMatrixRole,
  RecordsEffectiveGrantCell,
  RecordsTypeEffectiveGrants,
  RecordsRoleGrantsView
} from '../utils/role-grants-admin'

export { requireGrantTarget, assertRecordsPermissionSlug, listRecordsUserGrants } from '../utils/user-grants'
export type { RecordsUserGrantEntry } from '../utils/user-grants'

export { listRecords, requireRecordType, assertRecordVisible, parseRecordsFilterGroup } from '../utils/list-records'
export type { RecordsListOpts, RecordListItem, RecordsListResult } from '../utils/list-records'
export { RECORDS_FILTER_ME, recordsFilterRuleCount } from '../../client/filters'
export type { RecordsFilterGroup, RecordsFilterNode, RecordsFilterRule, RecordsFilterOp } from '../../client/filters'

export { closingRulesOf, isClosedStatus } from '../utils/closing'
export type { RecordsClosingRules } from '../utils/closing'

export { recordRecordsActivity } from '../utils/records-activity'
export type { RecordsActivityAction, RecordsActivityOpts } from '../utils/records-activity'

export {
  listComments,
  addComment,
  updateComment,
  deleteComment,
  getCommentRecord,
  encodeTimelineCursor,
  decodeTimelineCursor,
  clampTimelineLimit
} from '../utils/comments'
export type {
  RecordsComment,
  RecordsCommentPage,
  RecordsCommentRef,
  AddCommentOpts,
  CommentModerationOpts,
  RecordsTimelineCursor,
  RecordsTimelineListOpts
} from '../utils/comments'

export { listActivity } from '../utils/activity'
export type { RecordsActivityItem, RecordsActivityPage } from '../utils/activity'

export { listShares, addShare, removeShare, hasEditShare } from '../utils/shares'
export type { RecordsShareEntry, RecordsShareLevel } from '../utils/shares'

export {
  createRecordType,
  updateRecordType,
  updateTypeRoleGrants,
  deleteRecordType,
  createField,
  updateField,
  deleteField,
  availableAdminFieldKinds,
  RECORDS_SCHEMA_SLUG_RE,
  RECORDS_OPTION_KEY_RE,
  RECORDS_ADMIN_FIELD_KINDS
} from '../utils/schema-admin'
export type {
  RecordsAdminFieldKind,
  CreateRecordTypeInput,
  UpdateRecordTypePatch,
  CreateFieldInput,
  UpdateFieldPatch
} from '../utils/schema-admin'
