import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerTeamContainer } from '#core/server/utils/team-access'
import { registerAiFeature, registerAiReindexer, registerAiUsageSubjects } from '#ai/server'
import { CONTEXT_ASSISTANT_FEATURE, CONTEXT_PORTFOLIO_SUBJECT, contextPortfolioNames } from '../utils/assistant'
import { CONTEXT_EMBEDDINGS_FEATURE, CONTEXT_REINDEXER } from '../utils/section-index'
import {
  CONTEXT_PERMISSIONS,
  CONTEXT_PERMISSION_META,
  CONTEXT_DEFAULT_GRANTS
} from '../../app/utils/permissions'

export default defineNitroPlugin(() => {
  registerPermissions(CONTEXT_PERMISSIONS, CONTEXT_PERMISSION_META)
  registerDefaultGrants('context', CONTEXT_DEFAULT_GRANTS)
  registerTeamContainer({
    appId: 'context',
    table: 'context_portfolios',
    visibilityColumn: 'visibility',
    teamsTable: 'context_portfolio_teams',
    allTeamsPermission: 'context.all_teams'
  })

  // The admin AI page shows a model picker for this. A no-op when the AI layer
  // isn't loaded (core ships a fallback).
  registerAiFeature({
    key: CONTEXT_ASSISTANT_FEATURE,
    label: 'Context — portfolio assistant',
    description: 'Chats about portfolios and proposes section updates.'
  })
  // Breaks the assistant's spend down by portfolio on the AI spend page.
  registerAiUsageSubjects({ prefix: CONTEXT_PORTFOLIO_SUBJECT, label: 'Portfolio', resolve: contextPortfolioNames })

  // Section search index: switches the embedding-model section on in the AI
  // settings pages, and lets them rebuild this index after a model change.
  registerAiFeature({
    key: CONTEXT_EMBEDDINGS_FEATURE,
    label: 'Context — section search',
    description: 'Vector index over portfolio sections, embedded on save.',
    kind: 'embedding'
  })
  registerAiReindexer(CONTEXT_REINDEXER)

  registerApp({
    id: 'context',
    title: 'Context',
    path: '/context',
    icon: 'i-lucide-book-open-text',
    requiredPermission: 'context.access',
    defaultStatus: 'available',
    order: 25
  })

  registerNavItem({
    appId: 'context',
    title: 'Portfolios',
    path: '/context',
    icon: 'i-lucide-folder-open',
    requiredPermission: 'context.read',
    order: 10
  })
  registerNavItem({
    appId: 'context',
    title: 'Settings',
    path: '/context/settings',
    icon: 'i-lucide-settings',
    requiredPermission: 'context.settings',
    order: 90
  })
})
