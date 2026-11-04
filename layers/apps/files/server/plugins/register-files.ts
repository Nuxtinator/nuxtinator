import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import {
  FILES_PERMISSIONS,
  FILES_PERMISSION_META,
  FILES_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(FILES_PERMISSIONS, FILES_PERMISSION_META)
  registerDefaultGrants('files', FILES_DEFAULT_GRANTS)

  registerApp({
    id: 'files',
    title: 'Files',
    path: '/files',
    icon: 'i-lucide-folder',
    requiredPermission: 'files.access',
    defaultStatus: 'available',
    order: 25
  })

  registerNavItem({
    appId: 'files',
    title: 'All files',
    path: '/files',
    icon: 'i-lucide-files',
    requiredPermission: 'files.read',
    order: 10
  })
})
