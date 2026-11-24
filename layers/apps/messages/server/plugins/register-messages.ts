import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import {
  MESSAGES_PERMISSIONS,
  MESSAGES_PERMISSION_META,
  MESSAGES_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(MESSAGES_PERMISSIONS, MESSAGES_PERMISSION_META)
  registerDefaultGrants('messages', MESSAGES_DEFAULT_GRANTS)

  registerApp({
    id: 'messages',
    title: 'Messages',
    path: '/messages',
    icon: 'i-lucide-message-square',
    requiredPermission: 'messages.access',
    category: 'people'
  })

  registerNavItem({
    appId: 'messages',
    title: 'Inbox',
    path: '/messages',
    icon: 'i-lucide-inbox',
    requiredPermission: 'messages.read',
    order: 10
  })
})
