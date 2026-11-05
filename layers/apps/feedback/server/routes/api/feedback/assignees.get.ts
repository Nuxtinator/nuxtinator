// GET /api/feedback/assignees
// Lists users assignable to feedback cards. In multi-tenant mode that is the
// members of the active org; in single-tenant mode it is all users.
// With `?project_id=`, only the users who could see that project, for the
// project's notify-list picker.

import { getQuery } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { filterRecipients } from '#core/server/utils/team-access'
import { assertFeedbackProjectAccess, getFeedbackTeamScope } from '../../../utils/project-teams'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const projectId = typeof query.project_id === 'string' ? query.project_id : ''

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.read', async (tx, ctx) => {
    if (projectId) {
      await assertFeedbackProjectAccess(tx, await getFeedbackTeamScope(event, tx, ctx), projectId)
    }
    const visibleOnly = async <T extends { id: string }>(rows: T[]): Promise<T[]> => {
      if (!projectId) return rows
      const keep = new Set(await filterRecipients(tx, 'projects', projectId, rows.map(r => r.id)))
      return rows.filter(r => keep.has(r.id))
    }

    if (ctx.orgId) {
      const rows = await visibleOnly(await tx
        .selectFrom('memberships')
        .innerJoin('users', 'users.id', 'memberships.user_id')
        .select(['users.id', 'users.display_name', 'users.avatar'])
        .where('memberships.org_id', '=', ctx.orgId)
        .orderBy('users.display_name', 'asc')
        .execute())
      return { users: rows.map(r => ({ id: r.id, display_name: r.display_name, avatar: r.avatar })) }
    }

    const rows = await visibleOnly(await tx
      .selectFrom('users')
      .select(['id', 'display_name', 'avatar'])
      .orderBy('display_name', 'asc')
      .execute())
    return { users: rows.map(r => ({ id: r.id, display_name: r.display_name, avatar: r.avatar })) }
  })
})
