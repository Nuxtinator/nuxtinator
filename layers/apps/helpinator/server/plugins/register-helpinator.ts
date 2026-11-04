import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerAiFeature, registerAiReindexer, registerAiUsageSubjects } from '#ai/server'
import { HELPINATOR_CHAT_FEATURE, HELPINATOR_EMBEDDINGS_FEATURE } from '../utils/helpinator-bot'
import { HELPINATOR_REINDEXER } from '../utils/helpinator-crawl'
import { HELPINATOR_WIDGET_SUBJECT, helpinatorWidgetNames } from '../utils/helpinator-widgets'
import {
  HELPINATOR_PERMISSIONS,
  HELPINATOR_PERMISSION_META,
  HELPINATOR_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(HELPINATOR_PERMISSIONS, HELPINATOR_PERMISSION_META)
  registerDefaultGrants('helpinator', HELPINATOR_DEFAULT_GRANTS)

  // One model for every widget in an org, picked on the AI settings pages.
  registerAiFeature({
    key: HELPINATOR_CHAT_FEATURE,
    label: 'Helpinator — help chat',
    description: 'Answers website visitors from the widget\'s libraries.'
  })
  // The library search index: switches the embedding-model section on in the
  // AI settings pages, and lets them rebuild the index after a model change.
  registerAiFeature({
    key: HELPINATOR_EMBEDDINGS_FEATURE,
    label: 'Helpinator — library search',
    description: 'Vector index over crawled library pages.',
    kind: 'embedding'
  })
  registerAiReindexer(HELPINATOR_REINDEXER)
  // Breaks chat spend down by widget on the AI spend page.
  registerAiUsageSubjects({ prefix: HELPINATOR_WIDGET_SUBJECT, label: 'Widget', resolve: helpinatorWidgetNames })

  registerApp({
    id: 'helpinator',
    title: 'Helpinator',
    path: '/helpinator',
    icon: 'i-lucide-message-circle-question',
    requiredPermission: 'helpinator.access',
    order: 45
  })

  registerNavItem({
    appId: 'helpinator',
    title: 'Conversations',
    path: '/helpinator',
    icon: 'i-lucide-messages-square',
    requiredPermission: 'helpinator.access',
    order: 10
  })
  registerNavItem({
    appId: 'helpinator',
    title: 'Libraries',
    path: '/helpinator/libraries',
    icon: 'i-lucide-library',
    requiredPermission: 'helpinator.manage',
    order: 15
  })
  registerNavItem({
    appId: 'helpinator',
    title: 'Widgets',
    path: '/helpinator/widgets',
    icon: 'i-lucide-app-window',
    requiredPermission: 'helpinator.manage',
    order: 20
  })
})
