import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerRecordType, registerRecordsClosingHook, registerRecordsPatchGuard, registerRecordsStorageDriver } from '#records/server'
import { CRM_PERMISSIONS, CRM_PERMISSION_META, CRM_DEFAULT_GRANTS } from '../../app/utils/permissions'
import { contactsManifest } from '../../app/utils/manifests/contacts'
import { registerCrmChannelType, registerCrmConsentPurpose } from '../utils/crm-registry'
import { channelStorageDriver } from '../utils/channel-storage'
import { revokeConsentClosingHook } from '../utils/consent-on-close'
import { accountLinkPatchGuard } from '../utils/account-link'

export default defineNitroPlugin(() => {
  registerPermissions(CRM_PERMISSIONS, CRM_PERMISSION_META)
  registerDefaultGrants('crm', CRM_DEFAULT_GRANTS)
  registerApp({
    id: 'crm',
    title: 'CRM',
    path: '/crm',
    icon: 'i-lucide-contact',
    requiredPermission: 'crm.access',
    defaultStatus: 'available',
    order: 30
  })
  registerNavItem({
    appId: 'crm',
    title: 'Contacts',
    path: '/crm/contacts',
    icon: 'i-lucide-users',
    requiredPermission: 'crm.contacts.read',
    order: 10
  })

  registerRecordType(contactsManifest)
  registerRecordsStorageDriver(channelStorageDriver)
  registerRecordsClosingHook(revokeConsentClosingHook)
  registerRecordsPatchGuard(accountLinkPatchGuard)

  registerCrmChannelType({ typeKey: 'email', label: 'Email', icon: 'i-lucide-mail', valueFormat: 'email' })
  registerCrmChannelType({ typeKey: 'phone', label: 'Phone', icon: 'i-lucide-phone', valueFormat: 'phone' })
  registerCrmConsentPurpose('marketing', {
    title: 'Marketing',
    description: 'Bulk marketing and campaign messages.'
  })
  registerCrmConsentPurpose('transactional', {
    title: 'Transactional',
    description: 'Operational messages tied to the recipient\'s own activity.'
  })
})
