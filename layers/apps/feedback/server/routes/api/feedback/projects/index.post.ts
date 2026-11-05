import { readBody } from 'h3'
import { withOrgPermission } from '#tenant/server'
import { logCreate } from '#core/server/utils/activity-logger'
import { readContainerTeamsInput, setContainerTeams } from '#core/server/utils/team-access'
import { getFeedbackTeamScope, withFeedbackProjectTeams } from '../../../../utils/project-teams'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) ?? {}
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const description = typeof body.description === 'string' ? body.description : null
  const postMeta = (body.post_meta && typeof body.post_meta === 'object')
    ? (body.post_meta as Record<string, any>)
    : {}

  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'name is required' })
  }
  const teamsInput = readContainerTeamsInput('projects', body)

  return await withOrgPermission(event, { appId: 'feedback' }, 'feedback.write', async (tx, ctx) => {
    const created = await tx
      .insertInto('projects')
      .values({
        name,
        description,
        post_meta: postMeta as any
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await tx
      .insertInto('swimlanes')
      .values({
        project_id: created.id,
        name: 'default',
        is_default: true,
        position: 0
      })
      .execute()

    if (teamsInput) {
      const scope = await getFeedbackTeamScope(event, tx, ctx)
      await setContainerTeams(tx, scope, 'projects', created.id, teamsInput)
    }

    const project = await tx
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow()

    logCreate('projects', project.id, ctx.userId, { name })
    return (await withFeedbackProjectTeams(tx, [project]))[0]
  })
})
