import { getQuery } from 'h3'
import { withOrgContext } from '#tenant/server'
import { getGroupMode } from '#core/server/utils/groups'
import { getTeamContainers, listPickableTeams } from '#core/server/utils/team-access'
import type { Permission } from '#core/app/utils/permissions'

// The teams the caller can pick in the active org (host groups in single
// mode), for the team picker: their own teams, or every team of the org when
// `?app=<appId>` names an app whose `all_teams` permission they hold. Empty
// unless the org's groups run as teams. Archived teams are flagged: they keep
// working for what already uses them but can't be picked.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (tx, ctx) => {
    const mode = await getGroupMode(tx, ctx.orgId)
    const appId = getQuery(event).app
    const perm = typeof appId === 'string'
      ? getTeamContainers().find(c => c.appId === appId)?.allTeamsPermission
      : undefined
    const canShowAll = !!perm && ctx.perms.has(perm as Permission)
    return { mode, teams: await listPickableTeams(tx, { userId: ctx.userId, orgId: ctx.orgId, mode, canShowAll }) }
  })
})
