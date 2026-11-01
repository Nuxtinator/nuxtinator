// Server entry for the `#crm/server` alias — the surface consumer layers
// (email inbox, marketing, forms) import kernel services from.

export {
  registerCrmRecordType,
  getRegisteredRecordTypes,
  getRegisteredRecordType,
  registerCrmChannelType,
  getRegisteredChannelTypes,
  registerCrmConsentPurpose,
  getRegisteredConsentPurposes,
  registerCrmFieldFilter,
  runCrmFieldFilters
} from '../utils/crm-registry'
export type {
  CrmChannelTypeEntry,
  CrmConsentPurposeMeta,
  CrmFieldPatch,
  CrmFieldFilterPhase,
  CrmFieldFilter
} from '../utils/crm-registry'

export {
  getRecordTypes,
  getRecordType,
  getRecordTypeFields,
  getChannelTypes,
  getChannelType
} from '../utils/definition-settings'
export type {
  CrmRecordTypeSetting,
  CrmFieldSetting,
  CrmChannelTypeSetting
} from '../utils/definition-settings'

export { normalizeChannelValue, channelFingerprint } from '../utils/normalize'
export type { NormalizedChannelValue } from '../utils/normalize'

export {
  claimChannel, findChannel, linkChannel, unlinkChannel, setPrimary, markChannelVerified,
  issueChannelVerificationToken, consumeChannelVerificationToken
} from '../utils/channels'
export type { CrmChannelRow, CrmChannelLinkRow, LinkChannelOpts } from '../utils/channels'

export { hydrateRecords, getRecord, applyFieldPatch, deleteRecord } from '../utils/record-storage'
export type { CrmRecordRow, CrmHydratedRecord } from '../utils/record-storage'

export { permFor, CRM_RECORD_ACTIONS } from '../utils/crm-perms'
export type { CrmRecordAction, CrmTypeRoleGrants } from '../utils/crm-perms'

export {
  resolveTypePermission,
  resolveTypeCapabilities,
  requireTypePermission,
  canUpdateRecord,
  requireRecordUpdate
} from '../utils/type-permissions'
export type { CrmTypeCapabilities } from '../utils/type-permissions'

export { listMatrixRoles, buildRoleGrantsView } from '../utils/role-grants-admin'
export type {
  CrmMatrixRole,
  CrmEffectiveGrantCell,
  CrmTypeEffectiveGrants,
  CrmRoleGrantsView
} from '../utils/role-grants-admin'

export { requireGrantTarget, assertCrmPermissionSlug, listCrmUserGrants } from '../utils/user-grants'
export type { CrmUserGrantEntry } from '../utils/user-grants'

export { listRecords, requireRecordType, assertRecordVisible } from '../utils/list-records'
export type { CrmListOpts, CrmRecordListItem, CrmListResult } from '../utils/list-records'

export { closingRulesOf, isClosedStatus } from '../utils/closing'
export type { CrmClosingRules } from '../utils/closing'

export { recordCrmActivity } from '../utils/crm-activity'
export type { CrmActivityAction, CrmActivityOpts } from '../utils/crm-activity'

export { grantConsent, revokeConsent, getConsentState, getConsentEvents, canSend } from '../utils/consent'
export type { ConsentStateEntry, ConsentChangeInput, ConsentChangeResult, ConsentEventEntry, CrmConsentActor } from '../utils/consent'

export { suppress, clearSuppression, isSuppressed, getActiveSuppressions, recordDeliverySuppression, forceClearSuppression } from '../utils/suppression'
export type { SuppressInput, CrmSuppressionRow } from '../utils/suppression'

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
  CrmComment,
  CrmCommentPage,
  CrmCommentRef,
  AddCommentOpts,
  CommentModerationOpts,
  CrmTimelineCursor,
  CrmTimelineListOpts
} from '../utils/comments'

export { listActivity } from '../utils/activity'
export type { CrmActivityItem, CrmActivityPage } from '../utils/activity'

export { listShares, addShare, removeShare, hasEditShare } from '../utils/shares'
export type { CrmShareEntry, CrmShareLevel } from '../utils/shares'

export {
  createRecordType,
  updateRecordType,
  updateTypeRoleGrants,
  deleteRecordType,
  createField,
  updateField,
  deleteField,
  createChannelType,
  removeChannelType,
  CRM_SCHEMA_SLUG_RE,
  CRM_OPTION_KEY_RE,
  CRM_ADMIN_FIELD_KINDS,
  CRM_CHANNEL_VALUE_FORMATS
} from '../utils/schema-admin'
export type {
  CrmAdminFieldKind,
  CreateRecordTypeInput,
  UpdateRecordTypePatch,
  CreateFieldInput,
  UpdateFieldPatch,
  CreateChannelTypeInput
} from '../utils/schema-admin'
