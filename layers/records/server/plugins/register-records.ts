import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { RECORDS_PERMISSIONS, RECORDS_PERMISSION_META, RECORDS_DEFAULT_GRANTS } from '../../app/utils/permissions'
import { itemManifest } from '../../app/utils/manifests/item'
import { taskManifest } from '../../app/utils/manifests/task'
import { registerRecordType } from '../utils/records-registry'

export default defineNitroPlugin(() => {
  registerPermissions(RECORDS_PERMISSIONS, RECORDS_PERMISSION_META)
  registerDefaultGrants('records', RECORDS_DEFAULT_GRANTS)
  registerApp({
    id: 'records',
    title: 'Records',
    path: '/records',
    icon: 'i-lucide-database',
    requiredPermission: 'records.access',
    defaultStatus: 'default',
    order: 31
  })
  registerNavItem({
    appId: 'records',
    title: 'Records',
    path: '/records',
    icon: 'i-lucide-database',
    requiredPermission: 'records.access',
    order: 10
  })
  registerNavItem({
    appId: 'records',
    title: 'Settings',
    path: '/records/settings',
    icon: 'i-lucide-settings',
    requiredPermission: 'records.schema.manage',
    order: 90
  })
  registerRecordType(itemManifest)
  registerRecordType(taskManifest)
})
