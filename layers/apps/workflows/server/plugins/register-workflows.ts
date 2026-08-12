import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerAdminSection } from '#core/server/utils/admin-section-registry'
import {
  WORKFLOWS_PERMISSIONS,
  WORKFLOWS_PERMISSION_META,
  WORKFLOWS_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(WORKFLOWS_PERMISSIONS, WORKFLOWS_PERMISSION_META)
  registerDefaultGrants('workflows', WORKFLOWS_DEFAULT_GRANTS)

  registerApp({
    id: 'workflows',
    title: 'Workflows',
    path: '/workflows',
    icon: 'i-lucide-workflow',
    requiredPermission: 'workflows.use',
    order: 35
  })

  registerNavItem({
    appId: 'workflows',
    title: 'Views',
    path: '/workflows',
    icon: 'i-lucide-layout-dashboard',
    requiredPermission: 'workflows.use',
    order: 10
  })

  registerAdminSection({
    appId: 'workflows',
    title: 'Workflows',
    path: '/admin/workflows',
    icon: 'i-lucide-workflow',
    order: 65
  })
})
