import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerOrgSettingsSection } from '#core/server/utils/org-settings-section-registry'
import { registerAdminSection } from '#core/server/utils/admin-section-registry'
import { registerGroupUsage } from '#core/server/utils/groups'
import { RECORDS_PERMISSIONS, RECORDS_PERMISSION_META, RECORDS_DEFAULT_GRANTS } from '../../app/utils/permissions'
import { itemManifest } from '../../app/utils/manifests/item'
import { taskManifest } from '../../app/utils/manifests/task'
import { registerRecordType } from '../utils/records-registry'
import { getRecordTypes } from '../utils/definition-settings'

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
    order: 31,
    launcher: false
  })
  // Record types are managed from the org settings shell; single mode has
  // none, so there they sit in the host admin shell.
  if (useRuntimeConfig().public.tenancy) {
    registerOrgSettingsSection({
      appId: 'records',
      title: 'Records',
      path: 'records',
      icon: 'i-lucide-database',
      requiredPermission: 'records.schema.manage',
      order: 50
    })
  } else {
    registerAdminSection({
      appId: 'records',
      title: 'Records',
      path: '/admin/records',
      icon: 'i-lucide-database',
      order: 60
    })
  }
  // A team named in a record type's permissions can't be deleted while it is.
  registerGroupUsage('records', async (tx, groupIds) => {
    const types = await getRecordTypes(tx)
    return types.flatMap(t => groupIds
      .filter(id => t.teamGrants[id])
      .map(groupId => ({ id: t.key, title: t.label, groupId })))
  })
  registerRecordType(itemManifest)
  registerRecordType(taskManifest)
})
