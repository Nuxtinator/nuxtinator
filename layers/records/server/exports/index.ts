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
  RecordsVisibilitySource,
  RecordsShareVia
} from '../utils/records-registry'

export {
  getRecordTypes,
  getRecordType,
  getRecordTypeFields,
  recordsAccessGrantingKeys,
  RECORDS_DEFAULT_PERMISSION_PREFIX
} from '../utils/definition-settings'
export type { RecordTypeSetting, RecordsFieldSetting } from '../utils/definition-settings'

export { normalizeChannelValue, channelFingerprint } from '../utils/normalize'
export type { NormalizedChannelValue } from '../utils/normalize'

export { hydrateRecords, getRecord, applyFieldPatch, deleteRecord, activityValue } from '../utils/record-storage'
export type { RecordRow, RecordsHydratedRecord, ApplyFieldPatchOpts } from '../utils/record-storage'

export {
  addRecordAttachment,
  applyAttachmentsPatch,
  deleteRecordAttachments,
  listRecordAttachments,
  RECORDS_ATTACHMENT_MAX_MB,
  RECORDS_ATTACHMENTS_PER_FIELD
} from '../utils/attachments'
export type { RecordsAttachmentFile } from '../utils/attachments'

export { requireShareConfirmation, recordsUnsharedAssignees, RECORDS_SHARE_CONFIRMATION } from '../utils/share-confirmation'
export type { RecordsSharingMode, RecordsShareConfirmationUser } from '../utils/share-confirmation'

export { permFor, RECORD_ACTIONS } from '../utils/records-perms'
export type { RecordAction, RecordsTypeRoleGrants, RecordsTypeTeamGrants } from '../utils/records-perms'

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

export { listRecords, requireRecordType, requireAnyRecordTypeRead, assertRecordVisible, parseRecordsFilterGroup, visibleRecordIds, recordsVisibilityScope, RECORDS_VIRTUAL_SCALAR_KINDS } from '../utils/list-records'
export type { RecordsListOpts, RecordListItem, RecordsListResult, RecordsVisibilityScope, RecordsVirtualField } from '../utils/list-records'
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

export { listShares, listShareVia, addShare, removeShare, hasEditShare } from '../utils/shares'
export type { RecordsShareEntry, RecordsShareLevel } from '../utils/shares'

export {
  createRecordType,
  updateRecordType,
  updateTypeRoleGrants,
  updateTypeTeamGrants,
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
