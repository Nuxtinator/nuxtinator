// Server entry for the `#crm/server` alias — the contacts surface consumer
// layers (email inbox, marketing, forms) import from: channel identities and
// links, consent, suppression, and the channel-type catalog. Record CRUD and
// the rest of the kernel come from `#records/server`.

export {
  registerCrmChannelType,
  getRegisteredChannelTypes,
  registerCrmConsentPurpose,
  getRegisteredConsentPurposes
} from '../utils/crm-registry'
export type { CrmChannelTypeEntry, CrmConsentPurposeMeta } from '../utils/crm-registry'

export { getChannelTypes, getChannelType } from '../utils/channel-settings'
export type { CrmChannelTypeSetting } from '../utils/channel-settings'

export { createChannelType, removeChannelType, CRM_CHANNEL_VALUE_FORMATS } from '../utils/channel-types-admin'
export type { CreateChannelTypeInput } from '../utils/channel-types-admin'

export {
  claimChannel, findChannel, linkChannel, unlinkChannel, setPrimary, markChannelVerified,
  issueChannelVerificationToken, consumeChannelVerificationToken
} from '../utils/channels'
export type { CrmChannelRow, CrmChannelLinkRow, LinkChannelOpts } from '../utils/channels'

export { grantConsent, revokeConsent, getConsentState, getConsentEvents, canSend } from '../utils/consent'
export type { ConsentStateEntry, ConsentChangeInput, ConsentChangeResult, ConsentEventEntry, CrmConsentActor } from '../utils/consent'

export { revokeConsentOnClose } from '../utils/consent-on-close'

export { suppress, clearSuppression, isSuppressed, getActiveSuppressions, recordDeliverySuppression, forceClearSuppression } from '../utils/suppression'
export type { SuppressInput, CrmSuppressionRow } from '../utils/suppression'

export { accountOwnedChannelTypes, assertNotAccountOwned, linkedUserOf } from '../utils/account-link'
