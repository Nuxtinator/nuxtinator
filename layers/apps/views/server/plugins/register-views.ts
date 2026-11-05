import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerAdminSection } from '#core/server/utils/admin-section-registry'
import { registerRecordsVisibilitySource } from '#records/server'
import {
  VIEWS_PERMISSIONS,
  VIEWS_PERMISSION_META,
  VIEWS_DEFAULT_GRANTS
} from '../../app/utils/permissions'
import { boardVisibilitySource } from '../utils/board-visibility'

export default defineNitroPlugin(() => {
  registerPermissions(VIEWS_PERMISSIONS, VIEWS_PERMISSION_META)
  registerDefaultGrants('views', VIEWS_DEFAULT_GRANTS)

  registerApp({
    id: 'views',
    title: 'Views',
    path: '/views',
    icon: 'i-lucide-kanban',
    requiredPermission: 'views.use',
    defaultStatus: 'default',
    order: 35
  })

  registerNavItem({
    appId: 'views',
    title: 'Views',
    path: '/views',
    icon: 'i-lucide-layout-dashboard',
    requiredPermission: 'views.use',
    order: 10
  })

  registerAdminSection({
    appId: 'views',
    title: 'Views',
    path: '/admin/views',
    icon: 'i-lucide-kanban',
    order: 65
  })

  registerRecordsVisibilitySource(boardVisibilitySource)
})
