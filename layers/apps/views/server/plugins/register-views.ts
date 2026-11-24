import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerDefaultGrants } from '#core/server/utils/default-grants-registry'
import { registerApp } from '#core/server/utils/app-registry'
import { registerNavItem } from '#core/server/utils/nav-registry'
import { registerAdminSection } from '#core/server/utils/admin-section-registry'
import { registerTeamContainer } from '#core/server/utils/team-access'
import { registerRecordsRepeatHook, registerRecordsVisibilitySource } from '#records/server'
import {
  VIEWS_PERMISSIONS,
  VIEWS_PERMISSION_META,
  VIEWS_DEFAULT_GRANTS
} from '../../app/utils/permissions'
import { boardVisibilitySource } from '../utils/board-visibility'
import { carryViewsCardsOnRepeat } from '../utils/repeat-cards'
import { builtInViewId, registerBuiltInView } from '../utils/builtin-views'
import { subtasksBuiltInView } from '../utils/subtasks-view'

export default defineNitroPlugin(() => {
  registerPermissions(VIEWS_PERMISSIONS, VIEWS_PERMISSION_META)
  registerDefaultGrants('views', VIEWS_DEFAULT_GRANTS)

  registerTeamContainer({
    appId: 'views',
    table: 'views_definitions',
    visibilityColumn: 'visibility',
    teamsTable: 'views_teams',
    ownerColumn: 'owner_id',
    allTeamsPermission: 'views.all_teams'
  })

  registerApp({
    id: 'views',
    title: 'Views',
    path: '/views',
    icon: 'i-lucide-kanban',
    requiredPermission: 'views.use',
    defaultStatus: 'default',
    category: 'work',
    requires: ['records']
  })

  registerNavItem({
    appId: 'views',
    title: 'Views',
    path: '/views',
    icon: 'i-lucide-layout-dashboard',
    requiredPermission: 'views.use',
    order: 10
  })

  registerBuiltInView({
    key: 'my-tasks',
    name: 'My tasks',
    icon: 'i-lucide-square-check',
    recordTypeKey: 'task',
    order: 10,
    filter: () => ({ match: 'all', rules: [{ field: 'assignee', op: 'is', value: '@me' }] }),
    tabs: [
      { key: 'board', name: 'Board', layout: 'kanban', definition: { groupField: 'status' } },
      {
        key: 'open',
        name: 'Open',
        layout: 'list',
        definition: {
          filter: { match: 'all', rules: [{ field: 'status', op: 'none_of', value: ['done'] }] },
          sort: { field: 'due_date', dir: 'asc' }
        }
      },
      {
        key: 'due-soon',
        name: 'Due soon',
        layout: 'list',
        definition: {
          filter: {
            match: 'all',
            rules: [
              { field: 'status', op: 'none_of', value: ['done'] },
              { match: 'any', rules: [{ field: 'due_date', op: 'past' }, { field: 'due_date', op: 'next_days', value: 7 }] }
            ]
          },
          sort: { field: 'due_date', dir: 'asc' }
        }
      }
    ]
  })

  registerBuiltInView(subtasksBuiltInView)

  registerNavItem({
    appId: 'views',
    title: 'My tasks',
    path: `/views/${builtInViewId('my-tasks')}`,
    icon: 'i-lucide-square-check',
    requiredPermission: 'views.use',
    order: 5
  })

  registerAdminSection({
    appId: 'views',
    title: 'Views',
    path: '/admin/views',
    icon: 'i-lucide-kanban',
    order: 65
  })

  registerRecordsVisibilitySource(boardVisibilitySource)
  registerRecordsRepeatHook(carryViewsCardsOnRepeat)
})
