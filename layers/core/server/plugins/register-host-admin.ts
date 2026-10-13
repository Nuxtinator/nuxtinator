// Register the host's built-in admin shell entries. Same registry the app
// layers feed via their own Nitro plugins. `appId: 'host'` marks them as
// host-owned.
//
// The tenancy layer (when loaded) registers an additional "Organizations"
// section pointing at `/admin/orgs`. It's not registered here so that
// single-tenant deployments don't surface a dead nav entry.
import { registerAdminSection } from '../utils/admin-section-registry'

export default defineNitroPlugin(() => {
  registerAdminSection({
    appId: 'host',
    title: 'Dashboard',
    path: '/admin',
    icon: 'i-lucide-layout-dashboard',
    order: 0
  })

  registerAdminSection({
    appId: 'host',
    title: 'Users',
    path: '/admin/users',
    icon: 'i-lucide-users',
    order: 10
  })

  registerAdminSection({
    appId: 'host',
    title: 'Apps',
    path: '/admin/apps',
    icon: 'i-lucide-grid-2x2',
    order: 20
  })

  registerAdminSection({
    appId: 'host',
    title: 'Updates',
    path: '/admin/updates',
    icon: 'i-lucide-arrow-up-circle',
    order: 25
  })

  registerAdminSection({
    appId: 'host',
    title: 'Activity',
    path: '/admin/audit',
    icon: 'i-lucide-history',
    order: 30
  })

  registerAdminSection({
    appId: 'host',
    title: 'Settings',
    path: '/admin/settings',
    icon: 'i-lucide-settings',
    order: 40
  })
})
