import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import {
  VIDEOS_PERMISSIONS,
  VIDEOS_PERMISSION_META,
  VIDEOS_DEFAULT_GRANTS
} from '../../app/utils/permissions'
// Force-load the Database augmentation so `videos` shows up on the Database
// interface in every server file (TS only honors `declare module` from files
// that get loaded into the program graph).
import type {} from '../database/schema.d'

export default defineNitroPlugin(() => {
  registerPermissions(VIDEOS_PERMISSIONS, VIDEOS_PERMISSION_META)
  registerDefaultGrants('videos', VIDEOS_DEFAULT_GRANTS)

  registerApp({
    id: 'videos',
    title: 'Videos',
    path: '/videos',
    icon: 'i-lucide-video',
    requiredPermission: 'videos.access',
    defaultStatus: 'available',
    order: 30
  })

  registerNavItem({
    appId: 'videos',
    title: 'Library',
    path: '/videos',
    icon: 'i-lucide-library',
    requiredPermission: 'videos.read',
    order: 10
  })
  registerNavItem({
    appId: 'videos',
    title: 'Record',
    path: '/videos/record',
    icon: 'i-lucide-circle',
    requiredPermission: 'videos.write',
    order: 20
  })
  registerNavItem({
    appId: 'videos',
    title: 'Upload',
    path: '/videos/upload',
    icon: 'i-lucide-upload',
    requiredPermission: 'videos.write',
    order: 30
  })
})
