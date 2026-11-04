// Projects limited to teams: every member-facing route and MCP tool answers
// 404 to someone off the team, lists leave the project out, admins see it
// only with "show all teams", and the widget and notifications follow the
// project's teams.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  addFeedbackMember,
  withOrgHeader,
  createTestProject,
  createTestSwimlane,
  createTestCard,
  getColumnByName,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

type Headers = ReturnType<typeof withOrgHeader>

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err: unknown) {
    return (err as { statusCode?: number, response?: { status?: number } }).response?.status
      ?? (err as { statusCode?: number }).statusCode ?? 0
  }
}

function showAll(h: Headers) {
  return { headers: { ...h.headers, 'x-show-all-teams': '1' } }
}

describe('feedback team-limited projects', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  async function createGroup(slug: string, h: Headers, name: string, memberIds: string[]) {
    const group = await $fetch<{ id: string }>(`/api/o/${slug}/groups`, { method: 'POST', body: { name }, ...h })
    for (const userId of memberIds) {
      await $fetch(`/api/o/${slug}/groups/${group.id}/members/${userId}`, { method: 'PUT', ...h })
    }
    return group
  }

  async function limitTo(orgId: string, projectId: string, groupIds: string[]) {
    await sql`UPDATE projects SET visibility = 'teams' WHERE id = ${projectId}`
    for (const groupId of groupIds) {
      await sql`
        INSERT INTO feedback_project_teams (container_id, group_id, org_id)
        VALUES (${projectId}, ${groupId}, ${orgId})
      `
    }
  }

  // An org in teams mode with a Dev team (insider) and an Ops team (outsider),
  // a project limited to Dev and an org-wide project.
  async function setup() {
    const { org, user: admin, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const adminH = withOrgHeader(auth, org.slug)
    const insider = await addFeedbackMember(sql, org.id, ['member'])
    const outsider = await addFeedbackMember(sql, org.id, ['member'])
    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...adminH })
    const dev = await createGroup(org.slug, adminH, 'test-feedback-dev', [insider.user.id])
    const ops = await createGroup(org.slug, adminH, 'test-feedback-ops', [outsider.user.id])

    const inbox = await getColumnByName(sql, 'FEEDBACK INBOX')
    const project = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-dev-board' })
    await limitTo(org.id, project.id, [dev.id])
    const lane = await createTestSwimlane(sql, { org_id: org.id, project_id: project.id })
    const card = await createTestCard(sql, {
      org_id: org.id,
      project_id: project.id,
      swimlane_id: project.default_swimlane_id,
      column_id: inbox.id,
      post_type: 'feedback',
      post_meta: { submitter_email: 'someone@example.com' }
    })
    const open = await createTestProject(sql, { org_id: org.id, name: 'test-feedback-open-board' })
    const openCard = await createTestCard(sql, {
      org_id: org.id,
      project_id: open.id,
      swimlane_id: open.default_swimlane_id,
      column_id: inbox.id
    })

    return {
      org,
      admin,
      adminH,
      insider,
      insiderH: withOrgHeader(insider.auth, org.slug),
      outsider,
      outsiderH: withOrgHeader(outsider.auth, org.slug),
      dev,
      ops,
      inbox,
      project,
      lane,
      card,
      open,
      openCard
    }
  }

  it('answers 404 on every by-id route to someone off the team', async () => {
    const s = await setup()
    const h = s.outsiderH
    const p = s.project.id
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['project get', () => $fetch(`/api/feedback/projects/${p}`, h)],
      ['project patch', () => $fetch(`/api/feedback/projects/${p}`, { method: 'PATCH', body: { name: 'x' }, ...h })],
      ['project delete', () => $fetch(`/api/feedback/projects/${p}`, { method: 'DELETE', ...h })],
      ['swimlanes list', () => $fetch(`/api/feedback/swimlanes?project_id=${p}`, h)],
      ['swimlane create', () => $fetch('/api/feedback/swimlanes', { method: 'POST', body: { project_id: p, name: 'x' }, ...h })],
      ['swimlane delete', () => $fetch(`/api/feedback/swimlanes/${s.lane.id}`, { method: 'DELETE', ...h })],
      ['cards list', () => $fetch(`/api/feedback/cards?project_id=${p}`, h)],
      ['card create', () => $fetch('/api/feedback/cards', {
        method: 'POST',
        body: { project_id: p, swimlane_id: s.project.default_swimlane_id, column_id: s.inbox.id, title: 'x' },
        ...h
      })],
      ['card get', () => $fetch(`/api/feedback/cards/${s.card.id}`, h)],
      ['card patch', () => $fetch(`/api/feedback/cards/${s.card.id}`, { method: 'PATCH', body: { title: 'x' }, ...h })],
      ['card delete', () => $fetch(`/api/feedback/cards/${s.card.id}`, { method: 'DELETE', ...h })],
      ['card move (source)', () => $fetch(`/api/feedback/cards/${s.card.id}/move`, {
        method: 'PATCH',
        body: { column_id: s.inbox.id, project_id: s.open.id },
        ...h
      })],
      ['card move (destination)', () => $fetch(`/api/feedback/cards/${s.openCard.id}/move`, {
        method: 'PATCH',
        body: { column_id: s.inbox.id, project_id: p },
        ...h
      })],
      ['card read', () => $fetch(`/api/feedback/cards/${s.card.id}/read`, { method: 'POST', ...h })],
      ['card reply', () => $fetch(`/api/feedback/cards/${s.card.id}/reply`, { method: 'POST', body: { message: 'hi' }, ...h })],
      ['notify picker', () => $fetch(`/api/feedback/assignees?project_id=${p}`, h)]
    ]
    for (const [label, call] of calls) {
      expect(await status(call()), label).toBe(404)
    }

    const [project] = await sql`SELECT name FROM projects WHERE id = ${p}`
    expect(project?.name).toBe('test-feedback-dev-board')
    const cards = await sql<{ id: string, project_id: string, title: string }[]>`
      SELECT id, project_id, title FROM cards WHERE id IN (${s.card.id}, ${s.openCard.id})
    `
    expect(cards.find(c => c.id === s.card.id)).toMatchObject({ project_id: p })
    expect(cards.find(c => c.id === s.openCard.id)).toMatchObject({ project_id: s.open.id })
    const [lane] = await sql`SELECT id FROM swimlanes WHERE id = ${s.lane.id}`
    expect(lane).toBeTruthy()
  })

  it('leaves the project out of lists for someone off the team and shows it to the team', async () => {
    const s = await setup()

    const outsiderList = await $fetch<{ id: string }[]>('/api/feedback/projects', s.outsiderH)
    expect(outsiderList.map(x => x.id)).toContain(s.open.id)
    expect(outsiderList.map(x => x.id)).not.toContain(s.project.id)

    const insiderList = await $fetch<{ id: string, visibility: string, teams: { id: string, name: string }[] }[]>('/api/feedback/projects', s.insiderH)
    expect(insiderList.find(x => x.id === s.project.id)).toMatchObject({
      visibility: 'teams',
      teams: [{ id: s.dev.id, name: 'test-feedback-dev' }]
    })
    expect(insiderList.find(x => x.id === s.open.id)).toMatchObject({ visibility: 'org', teams: [] })

    const reorder = await $fetch<{ id: string }[]>('/api/feedback/projects/reorder', {
      method: 'POST',
      body: { orderedIds: [s.project.id, s.open.id] },
      ...s.outsiderH
    })
    expect(reorder.map(x => x.id)).toEqual([s.open.id])
    const [meta] = await sql<{ post_meta: Record<string, unknown> }[]>`SELECT post_meta FROM projects WHERE id = ${s.project.id}`
    expect(meta?.post_meta.sort_order).toBeUndefined()

    await $fetch(`/api/feedback/projects/${s.project.id}`, s.insiderH)
    await $fetch(`/api/feedback/swimlanes?project_id=${s.project.id}`, s.insiderH)
    const cards = await $fetch<{ id: string }[]>(`/api/feedback/cards?project_id=${s.project.id}`, s.insiderH)
    expect(cards.map(c => c.id)).toEqual([s.card.id])
    await $fetch(`/api/feedback/cards/${s.card.id}`, s.insiderH)
  })

  it('lets an admin off the team see the project only with show all teams', async () => {
    const s = await setup()

    expect(await status($fetch(`/api/feedback/projects/${s.project.id}`, s.adminH))).toBe(404)
    const plain = await $fetch<{ id: string }[]>('/api/feedback/projects', s.adminH)
    expect(plain.map(x => x.id)).not.toContain(s.project.id)

    await $fetch(`/api/feedback/projects/${s.project.id}`, showAll(s.adminH))
    await $fetch(`/api/feedback/cards/${s.card.id}`, showAll(s.adminH))
    const all = await $fetch<{ id: string }[]>('/api/feedback/projects', showAll(s.adminH))
    expect(all.map(x => x.id)).toContain(s.project.id)

    // The header does nothing for someone without feedback.all_teams.
    expect(await status($fetch(`/api/feedback/projects/${s.project.id}`, showAll(s.outsiderH)))).toBe(404)
  })

  it('keeps MCP tools to the caller\'s teams', async () => {
    const s = await setup()
    const token = await issueMcpBearer(sql, s.outsider.user.id, ['feedback.read', 'feedback.write'])
    const org = s.org.slug

    const projects = await callMcpTool(token, 'feedback_list_projects', { org })
    const projectIds = (projects.structuredContent?.projects as { id: string }[]).map(p => p.id)
    expect(projectIds).toContain(s.open.id)
    expect(projectIds).not.toContain(s.project.id)

    const cards = await callMcpTool(token, 'feedback_list_cards', { org })
    const cardIds = (cards.structuredContent?.cards as { id: string }[]).map(c => c.id)
    expect(cardIds).toContain(s.openCard.id)
    expect(cardIds).not.toContain(s.card.id)

    const refused: Array<[string, Record<string, unknown>]> = [
      ['feedback_list_cards', { org, project_id: s.project.id }],
      ['feedback_create_card', { org, project_id: s.project.id, title: 'x' }],
      ['feedback_move_card', { org, card_id: s.card.id, column: 'TODO' }],
      ['feedback_update_card', { org, card_id: s.card.id, title: 'x' }]
    ]
    for (const [tool, args] of refused) {
      const res = await callMcpTool(token, tool, args)
      expect(res.isError, tool).toBe(true)
      expect(res.content[0]?.text, tool).toMatch(/not found/i)
    }
    const [card] = await sql<{ title: string, column_id: string }[]>`SELECT title, column_id FROM cards WHERE id = ${s.card.id}`
    expect(card).toMatchObject({ title: s.card.title, column_id: s.inbox.id })

    const insiderToken = await issueMcpBearer(sql, s.insider.user.id, ['feedback.read'])
    const insiderCards = await callMcpTool(insiderToken, 'feedback_list_cards', { org, project_id: s.project.id })
    expect((insiderCards.structuredContent?.cards as { id: string }[]).map(c => c.id)).toEqual([s.card.id])
  })

  it('creates a team-limited board through MCP by team name', async () => {
    const s = await setup()
    const token = await issueMcpBearer(sql, s.insider.user.id, ['feedback.read', 'feedback.write'])
    const org = s.org.slug

    const res = await callMcpTool(token, 'feedback_create_project', { org, name: 'test-feedback-mcp-board', teams: ['TEST-FEEDBACK-DEV'] })
    expect(res.isError).toBeFalsy()
    const created = res.structuredContent as { id: string, visibility: string, teams: string[] }
    expect(created).toMatchObject({ visibility: 'teams', teams: ['test-feedback-dev'] })
    const outsiderToken = await issueMcpBearer(sql, s.outsider.user.id, ['feedback.read'])
    const listed = await callMcpTool(outsiderToken, 'feedback_list_projects', { org })
    expect((listed.structuredContent?.projects as { id: string }[]).map(p => p.id)).not.toContain(created.id)

    const unknown = await callMcpTool(token, 'feedback_create_project', { org, name: 'test-feedback-x', teams: ['test-feedback-ops'] })
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0]?.text).toMatch(/Teams you can pick: test-feedback-dev/)
  })

  it('saves visibility and teams on create and edit, with the save guard', async () => {
    const s = await setup()

    const created = await $fetch<{ id: string, visibility: string, teams: { id: string }[] }>('/api/feedback/projects', {
      method: 'POST',
      body: { name: 'test-feedback-new', visibility: 'teams', teamIds: [s.dev.id] },
      ...s.insiderH
    })
    expect(created).toMatchObject({ visibility: 'teams', teams: [{ id: s.dev.id }] })
    expect(await status($fetch(`/api/feedback/projects/${created.id}`, s.outsiderH))).toBe(404)

    // Picking a team you aren't on.
    expect(await status($fetch(`/api/feedback/projects/${created.id}`, {
      method: 'PATCH',
      body: { visibility: 'teams', teamIds: [s.dev.id, s.ops.id] },
      ...s.insiderH
    }))).toBe(403)

    // Dropping your own team.
    await limitTo(s.org.id, created.id, [s.ops.id])
    expect(await status($fetch(`/api/feedback/projects/${created.id}`, {
      method: 'PATCH',
      body: { visibility: 'teams', teamIds: [s.ops.id] },
      ...s.insiderH
    }))).toBe(409)

    const opened = await $fetch<{ visibility: string, teams: unknown[] }>(`/api/feedback/projects/${created.id}`, {
      method: 'PATCH',
      body: { visibility: 'org' },
      ...s.insiderH
    })
    expect(opened).toMatchObject({ visibility: 'org', teams: [] })
    await $fetch(`/api/feedback/projects/${created.id}`, s.outsiderH)

    // Other fields save without touching teams.
    await limitTo(s.org.id, created.id, [s.dev.id])
    const renamed = await $fetch<{ name: string, visibility: string }>(`/api/feedback/projects/${created.id}`, {
      method: 'PATCH',
      body: { name: 'test-feedback-renamed' },
      ...s.insiderH
    })
    expect(renamed).toMatchObject({ name: 'test-feedback-renamed', visibility: 'teams' })
  })

  it('refuses to limit a project to teams in an audiences org', async () => {
    const { org, user, auth } = await createFeedbackOrgWith(sql, ['admin'])
    const h = withOrgHeader(auth, org.slug)
    const group = await createGroup(org.slug, h, 'test-feedback-audience', [user.id])
    const project = await createTestProject(sql, { org_id: org.id })
    const err = await $fetch(`/api/feedback/projects/${project.id}`, {
      method: 'PATCH',
      body: { visibility: 'teams', teamIds: [group.id] },
      ...h
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
    expect(err.statusMessage).toMatch(/Teams are off/)
  })

  it('notifies only people who can see the project', async () => {
    const s = await setup()
    const allTeams = await addFeedbackMember(sql, s.org.id, ['admin'])
    await sql`
      UPDATE projects
      SET post_meta = ${sql.json({ notify_user_ids: [s.insider.user.id, s.outsider.user.id, allTeams.user.id] })}
      WHERE id = ${s.project.id}
    `

    await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: s.project.id, problem_description: 'broken', submitter_name: 'Tester', feedback_sub_type: 'bug' }
    })

    const rows = await sql<{ user_id: string }[]>`
      SELECT user_id FROM notifications WHERE org_id = ${s.org.id} AND app_id = 'feedback'
    `
    expect(rows.map(r => r.user_id).sort()).toEqual([s.insider.user.id, allTeams.user.id].sort())

    // `all_teams` held as a direct grant, with no role permissions, counts too.
    const granted = await addFeedbackMember(sql, s.org.id, [])
    for (const permission of ['feedback.read', 'feedback.all_teams']) {
      await sql`INSERT INTO user_permission_grants (user_id, permission, org_id) VALUES (${granted.user.id}, ${permission}, ${s.org.id})`
    }
    await sql`DELETE FROM notifications WHERE org_id = ${s.org.id}`
    await sql`
      UPDATE projects SET post_meta = ${sql.json({ notify_user_ids: [granted.user.id, s.outsider.user.id] })}
      WHERE id = ${s.project.id}
    `
    await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: s.project.id, problem_description: 'broken again', submitter_name: 'Tester', feedback_sub_type: 'bug' }
    })
    const again = await sql<{ user_id: string }[]>`
      SELECT user_id FROM notifications WHERE org_id = ${s.org.id} AND app_id = 'feedback'
    `
    expect(again.map(r => r.user_id)).toEqual([granted.user.id])

    const picker = await $fetch<{ users: { id: string }[] }>(`/api/feedback/assignees?project_id=${s.project.id}`, s.insiderH)
    const ids = picker.users.map(u => u.id)
    expect(ids).toContain(s.insider.user.id)
    expect(ids).toContain(allTeams.user.id)
    expect(ids).not.toContain(s.outsider.user.id)
  })

  it('refuses a swimlane from another project', async () => {
    const s = await setup()
    const h = s.insiderH
    const create = $fetch('/api/feedback/cards', {
      method: 'POST',
      body: { project_id: s.open.id, swimlane_id: s.lane.id, column_id: s.inbox.id, title: 'stray' },
      ...h
    })
    expect(await status(create)).toBe(400)
    expect(await status($fetch(`/api/feedback/cards/${s.openCard.id}`, { method: 'PATCH', body: { swimlane_id: s.lane.id }, ...h }))).toBe(400)
    expect(await status($fetch(`/api/feedback/cards/${s.openCard.id}/move`, {
      method: 'PATCH',
      body: { column_id: s.inbox.id, swimlane_id: s.lane.id, project_id: s.open.id },
      ...h
    }))).toBe(400)
    const [card] = await sql<{ swimlane_id: string }[]>`SELECT swimlane_id FROM cards WHERE id = ${s.openCard.id}`
    expect(card!.swimlane_id).toBe(s.open.default_swimlane_id)
  })

  it('takes widget feedback into a team-limited project', async () => {
    const s = await setup()
    const res = await $fetch<{ id: string }>('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: s.project.id, problem_description: 'from the widget', submitter_name: 'Tester', feedback_sub_type: 'bug' }
    })
    const [card] = await sql`SELECT project_id FROM cards WHERE id = ${res.id}`
    expect(card?.project_id).toBe(s.project.id)
  })

  it('blocks deleting a team or switching to audiences while a project uses it', async () => {
    const s = await setup()

    const del = await $fetch(`/api/o/${s.org.slug}/groups/${s.dev.id}`, { method: 'DELETE', ...s.adminH }).catch(e => e)
    expect(del.statusCode).toBe(409)
    expect(JSON.stringify(del.data)).toContain(s.project.id)

    const mode = await $fetch(`/api/o/${s.org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'audiences' }, ...s.adminH }).catch(e => e)
    expect(mode.statusCode).toBe(409)

    // An unused team still deletes.
    await $fetch(`/api/o/${s.org.slug}/groups/${s.ops.id}`, { method: 'DELETE', ...s.adminH })
  })

  it('deleting the org removes its team-limited projects', async () => {
    const s = await setup()
    await sql`DELETE FROM orgs WHERE id = ${s.org.id}`
    const rows = await sql`SELECT 1 FROM feedback_project_teams WHERE container_id = ${s.project.id}`
    expect(rows.length).toBe(0)
  })
})
