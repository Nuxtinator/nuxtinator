// Team-limited portfolios: every member-facing route and MCP tool that names
// one answers 404 to someone off its teams, lists and search leave it out, and
// only an admin showing all teams reaches it without being on a team.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  addContextMember,
  createTestPortfolio,
  seedTestSection,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool,
  primeAiFake,
  resetAiFake,
  getAiFakeLog
} from '../helpers'
import { CONTEXT_PERMISSIONS } from '../../app/utils/permissions'

type Opts = { headers: Record<string, string> }

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err: unknown) {
    const e = err as { statusCode?: number, response?: { status?: number } }
    return e.response?.status ?? e.statusCode ?? 0
  }
}

function showAll(opts: Opts): Opts {
  return { headers: { ...opts.headers, 'x-show-all-teams': '1' } }
}

function systemText(call: { system?: unknown }): string {
  const s = call.system
  if (typeof s === 'string') return s
  return Array.isArray(s) ? s.map(p => String((p as { text?: string }).text ?? '')).join('') : ''
}

describe('team-limited portfolios', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  async function setup() {
    const { org, user: admin, auth } = await createContextOrgWith(sql, ['admin'])
    const adminH = withOrgHeader(auth, org.slug)
    const outsider = await addContextMember(sql, org.id, ['member'])
    const teamMember = await addContextMember(sql, org.id, ['member'])
    const outsiderH = withOrgHeader(outsider.auth, org.slug)
    const teamH = withOrgHeader(teamMember.auth, org.slug)

    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...adminH })
    const group = await $fetch<{ id: string }>(`/api/o/${org.slug}/groups`, { method: 'POST', body: { name: `test-context-dev-${randomUUID().slice(0, 6)}` }, ...adminH })
    await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${teamMember.user.id}`, { method: 'PUT', ...adminH })

    const hidden = await createTestPortfolio(sql, { org_id: org.id, name: 'Dev Only', builtin_sections: ['identity', 'team'] })
    await sql`UPDATE context_portfolios SET visibility = 'teams' WHERE id = ${hidden.id}`
    await sql`INSERT INTO context_portfolio_teams (container_id, group_id, org_id) VALUES (${hidden.id}, ${group.id}, ${org.id})`
    const open = await createTestPortfolio(sql, { org_id: org.id, name: 'Everyone', builtin_sections: ['identity'] })

    return { org, admin, adminH, outsider, outsiderH, teamMember, teamH, group, hidden, open }
  }

  async function seedChildren(s: Awaited<ReturnType<typeof setup>>) {
    const section = await seedTestSection(sql, { portfolio_id: s.hidden.id, section_key: 'identity', content: 'Secret dev roadmap.' })
    const [version] = await sql<{ id: string }[]>`
      INSERT INTO context_section_versions (section_id, content, edited_by)
      VALUES (${section.id}, 'Older roadmap.', ${s.teamMember.user.id}) RETURNING id
    `
    const [comment] = await sql<{ id: string }[]>`
      INSERT INTO context_section_comments (section_id, author_id, quoted_text, anchor_start, anchor_end, anchor_hash, content)
      VALUES (${section.id}, ${s.admin.id}, 'Secret', 0, 6, 'x', 'A note') RETURNING id
    `
    const [reply] = await sql<{ id: string }[]>`
      INSERT INTO context_section_comment_replies (comment_id, author_id, content)
      VALUES (${comment!.id}, ${s.admin.id}, 'A reply') RETURNING id
    `
    const [set] = await sql<{ id: string }[]>`
      INSERT INTO context_suggestion_sets (portfolio_id, author_id, note, org_id)
      VALUES (${s.hidden.id}, ${s.admin.id}, 'note', ${s.org.id}) RETURNING id
    `
    const [suggestion] = await sql<{ id: string }[]>`
      INSERT INTO context_suggestions (set_id, portfolio_id, section_key, base_content, proposed_content, status, org_id)
      VALUES (${set!.id}, ${s.hidden.id}, 'identity', 'Secret dev roadmap.', 'New roadmap.', 'pending', ${s.org.id}) RETURNING id
    `
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO context_assistant_conversations (user_id, portfolio_id, org_id)
      VALUES (${s.admin.id}, ${s.hidden.id}, ${s.org.id}) RETURNING id
    `
    const proposal = {
      portfolio_slug: s.hidden.slug,
      portfolio_name: 'Dev Only',
      section_key: 'identity',
      section_title: 'Identity',
      current_content: 'Secret dev roadmap.',
      proposed_content: 'Leaked.',
      status: 'pending'
    }
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO context_assistant_messages (conversation_id, role, content, proposals)
      VALUES (${conversation!.id}, 'assistant', 'Here', ${JSON.stringify([proposal])}::text::jsonb) RETURNING id
    `
    const [allConversation] = await sql<{ id: string }[]>`
      INSERT INTO context_assistant_conversations (user_id, portfolio_id, org_id)
      VALUES (${s.admin.id}, NULL, ${s.org.id}) RETURNING id
    `
    const [allMessage] = await sql<{ id: string }[]>`
      INSERT INTO context_assistant_messages (conversation_id, role, content, proposals)
      VALUES (${allConversation!.id}, 'assistant', 'Here', ${JSON.stringify([proposal])}::text::jsonb) RETURNING id
    `
    return {
      versionId: version!.id,
      commentId: comment!.id,
      replyId: reply!.id,
      setId: set!.id,
      suggestionId: suggestion!.id,
      conversationId: conversation!.id,
      messageId: message!.id,
      allConversationId: allConversation!.id,
      allMessageId: allMessage!.id
    }
  }

  it('answers 404 on every route that names the portfolio or its children, for someone off its teams', async () => {
    const s = await setup()
    const c = await seedChildren(s)
    const base = `/api/context/portfolios/${s.hidden.slug}`
    const sec = `${base}/sections/identity`
    const routes: Array<[string, string, unknown?]> = [
      ['GET', base],
      ['PATCH', base, { name: 'Renamed' }],
      ['GET', `${base}/export`],
      ['POST', `${base}/icon`, {}],
      ['PUT', `${base}/section-order`, { keys: ['identity', 'team'] }],
      ['GET', `${base}/sections`],
      ['POST', `${base}/sections`, { title: 'Extra' }],
      ['GET', sec],
      ['PUT', sec, { content: 'Overwritten' }],
      ['PATCH', sec, { title: 'Renamed' }],
      ['GET', `${sec}/export`],
      ['POST', `${sec}/reindex`],
      ['GET', `${sec}/versions`],
      ['POST', `${sec}/versions/${c.versionId}/restore`],
      ['GET', `${sec}/comments`],
      ['POST', `${sec}/comments`, { content: 'Hi', quoted_text: 'Secret', anchor_start: 0, anchor_end: 6 }],
      ['POST', `${sec}/comments/${c.commentId}/replies`, { content: 'Hi' }],
      ['DELETE', `${sec}/comments/${c.commentId}/replies/${c.replyId}`],
      ['POST', `${sec}/comments/${c.commentId}/resolve`],
      ['POST', `${sec}/comments/${c.commentId}/unresolve`],
      ['DELETE', `${sec}/comments/${c.commentId}`],
      ['DELETE', sec],
      ['GET', `/api/context/suggestions/${c.setId}`],
      ['POST', `/api/context/suggestions/${c.setId}/decide`, { action: 'reject' }],
      ['POST', `/api/context/suggestions/${c.setId}/withdraw`, {}],
      ['POST', `/api/context/suggestions/${c.setId}/read`],
      ['GET', `/api/context/assistant/conversations?portfolio=${s.hidden.slug}`],
      ['POST', '/api/context/assistant/conversations', { portfolio: s.hidden.slug }],
      ['GET', `/api/context/assistant/conversations/${c.conversationId}`],
      ['POST', `/api/context/assistant/conversations/${c.conversationId}/messages`, { message: 'Hi' }],
      ['POST', `/api/context/assistant/conversations/${c.conversationId}/proposals`, { message_id: c.messageId, index: 0, action: 'apply' }],
      ['GET', `/api/context/assistant/conversations/${c.allConversationId}`],
      ['POST', `/api/context/assistant/conversations/${c.allConversationId}/messages`, { message: 'Hi' }],
      ['POST', `/api/context/assistant/conversations/${c.allConversationId}/proposals`, { message_id: c.allMessageId, index: 0, action: 'apply' }],
      ['DELETE', base]
    ]
    // The admin holds every permission (so no route stops at 403) but isn't on
    // the team and hasn't turned on "show all teams".
    for (const [method, path, body] of routes) {
      const got = await status($fetch(path, { method: method as 'GET', ...(body !== undefined ? { body } : {}), ...s.adminH }))
      expect(got, `${method} ${path}`).toBe(404)
    }

    const rows = await sql`SELECT 1 FROM context_portfolios WHERE id = ${s.hidden.id}`
    expect(rows).toHaveLength(1)
    const [section] = await sql<{ content: string }[]>`SELECT content FROM context_sections WHERE portfolio_id = ${s.hidden.id} AND section_key = 'identity'`
    expect(section!.content).toBe('Secret dev roadmap.')
  })

  it('answers 404 to a plain member off the team, including on their own suggestion', async () => {
    const s = await setup()
    await seedTestSection(sql, { portfolio_id: s.hidden.id, section_key: 'identity', content: 'Secret dev roadmap.' })
    const [set] = await sql<{ id: string }[]>`
      INSERT INTO context_suggestion_sets (portfolio_id, author_id, note, org_id)
      VALUES (${s.hidden.id}, ${s.outsider.user.id}, null, ${s.org.id}) RETURNING id
    `
    await sql`
      INSERT INTO context_suggestions (set_id, portfolio_id, section_key, base_content, proposed_content, status, org_id)
      VALUES (${set!.id}, ${s.hidden.id}, 'identity', 'Secret dev roadmap.', 'Mine.', 'pending', ${s.org.id})
    `
    expect(await status($fetch(`/api/context/portfolios/${s.hidden.slug}`, s.outsiderH))).toBe(404)
    expect(await status($fetch(`/api/context/portfolios/${s.hidden.slug}/sections/identity`, s.outsiderH))).toBe(404)
    expect(await status($fetch(`/api/context/suggestions/${set!.id}`, s.outsiderH))).toBe(404)
    expect(await status($fetch(`/api/context/suggestions/${set!.id}/withdraw`, { method: 'POST', body: {}, ...s.outsiderH }))).toBe(404)
  })

  it('leaves the portfolio out of lists, the suggestion queue and its count', async () => {
    const s = await setup()
    await seedChildren(s)
    for (const opts of [s.adminH, s.outsiderH]) {
      const { portfolios } = await $fetch<{ portfolios: { id: string }[] }>('/api/context/portfolios', opts)
      expect(portfolios.map(p => p.id)).toEqual([s.open.id])
    }
    const queue = await $fetch<{ sets: unknown[] }>('/api/context/suggestions', s.adminH)
    expect(queue.sets).toHaveLength(0)
    const count = await $fetch<{ count: number }>('/api/context/suggestions/pending-count', s.adminH)
    expect(count.count).toBe(0)
  })

  it('shows the portfolio to its team members, with its teams', async () => {
    const s = await setup()
    const { portfolios } = await $fetch<{ portfolios: { id: string, visibility: string, teams: { id: string }[] }[] }>('/api/context/portfolios', s.teamH)
    const p = portfolios.find(x => x.id === s.hidden.id)
    expect(p?.visibility).toBe('teams')
    expect(p?.teams.map(t => t.id)).toEqual([s.group.id])
    expect(await status($fetch(`/api/context/portfolios/${s.hidden.slug}/sections/identity`, s.teamH))).toBe(200)
  })

  it('shows it to an admin only while "show all teams" is on, and never for a member without the permission', async () => {
    const s = await setup()
    await seedChildren(s)
    const all = showAll(s.adminH)
    expect(await status($fetch(`/api/context/portfolios/${s.hidden.slug}`, all))).toBe(200)
    const { portfolios } = await $fetch<{ portfolios: { id: string }[] }>('/api/context/portfolios', all)
    expect(portfolios.map(p => p.id).sort()).toEqual([s.hidden.id, s.open.id].sort())
    expect((await $fetch<{ count: number }>('/api/context/suggestions/pending-count', all)).count).toBe(1)

    expect(await status($fetch(`/api/context/portfolios/${s.hidden.slug}`, showAll(s.outsiderH)))).toBe(404)
  })

  it('keeps hidden portfolios in place when someone off their teams reorders', async () => {
    const s = await setup()
    const last = await createTestPortfolio(sql, { org_id: s.org.id, name: 'Last', builtin_sections: ['identity'] })
    await sql`UPDATE context_portfolios SET "order" = CASE id WHEN ${s.open.id} THEN 0 WHEN ${s.hidden.id} THEN 1 ELSE 2 END WHERE org_id = ${s.org.id}`

    await $fetch('/api/context/portfolio-order', { method: 'PUT', body: { ids: [last.id, s.open.id] }, ...s.adminH })
    const rows = await sql<{ id: string, order: number }[]>`
      SELECT id, "order" FROM context_portfolios WHERE org_id = ${s.org.id} ORDER BY "order"
    `
    expect(rows.map(r => r.id)).toEqual([last.id, s.hidden.id, s.open.id])
    expect(await status($fetch('/api/context/portfolio-order', { method: 'PUT', body: { ids: [s.open.id, s.hidden.id, last.id] }, ...s.adminH }))).toBe(400)
  })

  it('hides an all-portfolio conversation once a portfolio it drew on is hidden', async () => {
    const s = await setup()
    const c = await seedChildren(s)
    const listed = async (h: Opts) => (await $fetch<{ conversations: { id: string }[] }>('/api/context/assistant/conversations', h)).conversations.map(x => x.id)
    expect(await listed(s.adminH)).not.toContain(c.allConversationId)
    expect(await listed(showAll(s.adminH))).toContain(c.allConversationId)
    expect(await status($fetch(`/api/context/assistant/conversations/${c.allConversationId}`, showAll(s.adminH)))).toBe(200)

    await $fetch(`/api/context/portfolios/${s.hidden.slug}/sections/identity`, { method: 'PUT', body: { content: 'Secret anvils roadmap for the dev team.' }, ...s.teamH })
    const { conversation } = await $fetch<{ conversation: { id: string } }>('/api/context/assistant/conversations', { method: 'POST', body: {}, ...s.teamH })
    await primeAiFake({ text: 'The roadmap is anvils.', toolCalls: [{ name: 'load_section', input: { portfolio: s.hidden.slug, section_key: 'identity' } }] })
    await $fetch(`/api/context/assistant/conversations/${conversation.id}/messages`, { method: 'POST', body: { message: 'What is the roadmap?' }, ...s.teamH })
    const [reply] = await sql<{ portfolio_ids: string[] }[]>`
      SELECT portfolio_ids FROM context_assistant_messages WHERE conversation_id = ${conversation.id} AND role = 'assistant'
    `
    expect(reply!.portfolio_ids).toEqual([s.hidden.id])
    expect(await listed(s.teamH)).toContain(conversation.id)

    await $fetch(`/api/o/${s.org.slug}/groups/${s.group.id}/members/${s.teamMember.user.id}`, { method: 'DELETE', ...s.adminH })
    expect(await listed(s.teamH)).not.toContain(conversation.id)
    expect(await status($fetch(`/api/context/assistant/conversations/${conversation.id}`, s.teamH))).toBe(404)

    await $fetch(`/api/context/assistant/conversations/${conversation.id}`, { method: 'DELETE', ...s.teamH })
    expect(await sql`SELECT 1 FROM context_assistant_conversations WHERE id = ${conversation.id}`).toHaveLength(0)
  })

  it('keeps an older all-portfolio conversation visible only when it predates every hidden portfolio', async () => {
    const s = await setup()
    const [{ created_at: hiddenAt }] = await sql<{ created_at: Date }[]>`SELECT created_at FROM context_portfolios WHERE id = ${s.hidden.id}`
    async function legacyChat(at: Date) {
      const [conv] = await sql<{ id: string }[]>`
        INSERT INTO context_assistant_conversations (user_id, portfolio_id, org_id)
        VALUES (${s.outsider.user.id}, NULL, ${s.org.id}) RETURNING id
      `
      await sql`
        INSERT INTO context_assistant_messages (conversation_id, role, content, created_at)
        VALUES (${conv!.id}, 'assistant', 'An answer', ${at})
      `
      return conv!.id
    }
    const before = await legacyChat(new Date(hiddenAt.getTime() - 86_400_000))
    const after = await legacyChat(new Date(hiddenAt.getTime() + 1000))

    const { conversations } = await $fetch<{ conversations: { id: string }[] }>('/api/context/assistant/conversations', s.outsiderH)
    expect(conversations.map(x => x.id)).toContain(before)
    expect(conversations.map(x => x.id)).not.toContain(after)
    expect(await status($fetch(`/api/context/assistant/conversations/${after}`, s.outsiderH))).toBe(404)
  })

  it('creates a team-limited portfolio through MCP by team name', async () => {
    const s = await setup()
    const [{ name: teamName }] = await sql<{ name: string }[]>`SELECT name FROM groups WHERE id = ${s.group.id}`
    const token = await issueMcpBearer(sql, s.teamMember.user.id, ['context.read', 'context.portfolio.create'])
    await sql`UPDATE memberships SET roles = ${['admin']} WHERE user_id = ${s.teamMember.user.id} AND org_id = ${s.org.id}`
    const res = await callMcpTool(token, 'create_portfolio', { org: s.org.slug, name: 'Team Notes', teams: [teamName!] })
    expect(res.isError).toBeFalsy()
    const { portfolio } = res.structuredContent as { portfolio: { slug: string, visibility: string, teams: string[] } }
    expect(portfolio).toMatchObject({ visibility: 'teams', teams: [teamName] })
    expect(await status($fetch(`/api/context/portfolios/${portfolio.slug}`, s.outsiderH))).toBe(404)
    expect(await status($fetch(`/api/context/portfolios/${portfolio.slug}`, s.teamH))).toBe(200)
  })

  it('keeps the assistant\'s all-portfolio context and search to visible portfolios', async () => {
    const s = await setup()
    await $fetch(`/api/context/portfolios/${s.hidden.slug}/sections/identity`, { method: 'PUT', body: { content: 'Secret anvils roadmap for the dev team.' }, ...s.teamH })
    await $fetch(`/api/context/portfolios/${s.open.slug}/sections/identity`, { method: 'PUT', body: { content: 'Public anvils for everyone.' }, ...s.teamH })

    const { conversation } = await $fetch<{ conversation: { id: string } }>('/api/context/assistant/conversations', { method: 'POST', body: {}, ...s.outsiderH })
    await primeAiFake({ text: 'ok', toolCalls: [{ name: 'search_sections', input: { query: 'anvils roadmap' } }] })
    await $fetch(`/api/context/assistant/conversations/${conversation.id}/messages`, { method: 'POST', body: { message: 'anvils roadmap' }, ...s.outsiderH })
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    const text = systemText(call)
    expect(text).toContain('Everyone')
    expect(text).not.toContain('Dev Only')
    expect(text).not.toContain('Secret')
    expect(call.toolResults[0]!.result).not.toContain('Secret')
  })

  it('creates and changes limited portfolios through the API', async () => {
    const s = await setup()
    const teamAdmin = await addContextMember(sql, s.org.id, ['admin'])
    await $fetch(`/api/o/${s.org.slug}/groups/${s.group.id}/members/${teamAdmin.user.id}`, { method: 'PUT', ...s.adminH })
    const teamAdminH = withOrgHeader(teamAdmin.auth, s.org.slug)

    const created = await $fetch<{ slug: string, visibility: string, teams: { id: string }[] }>('/api/context/portfolios', {
      method: 'POST', body: { name: 'Team made', visibility: 'teams', teamIds: [s.group.id] }, ...teamAdminH
    })
    expect(created.visibility).toBe('teams')
    expect(created.teams.map(t => t.id)).toEqual([s.group.id])
    expect(await status($fetch(`/api/context/portfolios/${created.slug}`, s.outsiderH))).toBe(404)

    const opened = await $fetch<{ visibility: string }>(`/api/context/portfolios/${created.slug}`, {
      method: 'PATCH', body: { visibility: 'org', teamIds: [] }, ...s.teamH
    })
    expect(opened.visibility).toBe('org')
    expect(await status($fetch(`/api/context/portfolios/${created.slug}`, s.outsiderH))).toBe(200)
  })

  it('refuses a save that would lock the caller out, unless they show all teams', async () => {
    const s = await setup()
    expect(await status($fetch('/api/context/portfolios', {
      method: 'POST', body: { name: 'Locked out', visibility: 'teams', teamIds: [s.group.id] }, ...s.adminH
    }))).toBe(409)
    expect(await status($fetch('/api/context/portfolios', {
      method: 'POST', body: { name: 'Recovered', visibility: 'teams', teamIds: [s.group.id] }, ...showAll(s.adminH)
    }))).toBe(200)
  })

  it('refuses to limit a portfolio to teams in an audiences org', async () => {
    const { org, auth } = await createContextOrgWith(sql, ['admin'])
    const h = withOrgHeader(auth, org.slug)
    const group = await $fetch<{ id: string }>(`/api/o/${org.slug}/groups`, { method: 'POST', body: { name: `test-context-aud-${randomUUID().slice(0, 6)}` }, ...h })
    expect(await status($fetch('/api/context/portfolios', {
      method: 'POST', body: { name: 'Nope', visibility: 'teams', teamIds: [group.id] }, ...h
    }))).toBe(400)
  })

  it('blocks deleting a team that limits a portfolio, and switching the org to audiences', async () => {
    const s = await setup()
    expect(await status($fetch(`/api/o/${s.org.slug}/groups/${s.group.id}`, { method: 'DELETE', ...s.adminH }))).toBe(409)
    expect(await status($fetch(`/api/o/${s.org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'audiences' }, ...s.adminH }))).toBe(409)
  })

  it('deletes the org along with its team-limited portfolios', async () => {
    const s = await setup()
    await sql`DELETE FROM orgs WHERE id = ${s.org.id}`
    expect(await sql`SELECT 1 FROM context_portfolios WHERE id = ${s.hidden.id}`).toHaveLength(0)
  })

  it('notifies only reviewers who can see the portfolio', async () => {
    const s = await setup()
    await seedTestSection(sql, { portfolio_id: s.hidden.id, section_key: 'identity', content: 'Secret dev roadmap.' })
    await sql`
      INSERT INTO user_permission_grants (id, user_id, permission, org_id)
      VALUES (gen_random_uuid(), ${s.outsider.user.id}, 'context.suggestion.review', ${s.org.id})
    `
    const token = await issueMcpBearer(sql, s.teamMember.user.id, ['context.read', 'context.write'])
    const res = await callMcpTool(token, 'update_section', { org: s.org.slug, portfolio_id: s.hidden.id, section_key: 'identity', content: 'Revised roadmap.' })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const setId = res.structuredContent!.suggestion_set_id as string

    const notified = await sql<{ user_id: string }[]>`
      SELECT user_id FROM notifications WHERE app_id = 'context' AND link = ${`/context/suggestions/${setId}`}
    `
    const ids = notified.map(n => n.user_id)
    expect(ids).toContain(s.admin.id)
    expect(ids).not.toContain(s.outsider.user.id)
  })

  describe('MCP tools', () => {
    it('answer "not found" for the portfolio and its suggestions, and leave it out of lists', async () => {
      const s = await setup()
      const c = await seedChildren(s)
      const token = await issueMcpBearer(sql, s.admin.id, [...CONTEXT_PERMISSIONS])
      const org = s.org.slug
      const pid = s.hidden.id
      const calls: Array<[string, Record<string, unknown>]> = [
        ['list_sections', { org, portfolio_id: pid }],
        ['read_section', { org, portfolio_id: pid, section_key: 'identity' }],
        ['bulk_read_sections', { org, portfolio_id: pid, section_keys: ['identity'] }],
        ['read_organization', { org, portfolio_id: pid }],
        ['update_section', { org, portfolio_id: pid, section_key: 'identity', content: 'x', mode: 'direct' }],
        ['bulk_update_sections', { org, portfolio_id: pid, updates: [{ section_key: 'identity', content: 'x' }], mode: 'direct' }],
        ['create_section', { org, portfolio_id: pid, title: 'Extra' }],
        ['bulk_create_sections', { org, portfolio_id: pid, sections: [{ title: 'Extra' }] }],
        ['delete_section', { org, portfolio_id: pid, section_key: 'team' }],
        ['list_suggestions', { org, portfolio_id: pid }],
        ['withdraw_suggestion', { org, suggestion_id: c.suggestionId }],
        ['read_suggestion', { org, suggestion_set_id: c.setId }],
        ['update_suggestion', { org, suggestion_set_id: c.setId, note: 'changed' }]
      ]
      for (const [name, args] of calls) {
        const res = await callMcpTool(token, name, args)
        expect(res.isError, name).toBe(true)
        expect(res.content[0]?.text, name).toMatch(/not found/i)
      }

      const listed = await callMcpTool(token, 'list_portfolios', { org })
      expect((listed.structuredContent!.portfolios as { id: string }[]).map(p => p.id)).toEqual([s.open.id])
      const mine = await callMcpTool(token, 'list_suggestions', { org })
      expect(mine.structuredContent!.suggestions).toEqual([])

      const [row] = await sql<{ content: string }[]>`SELECT content FROM context_sections WHERE portfolio_id = ${pid} AND section_key = 'identity'`
      expect(row!.content).toBe('Secret dev roadmap.')
      expect(await sql`SELECT 1 FROM context_section_definitions WHERE portfolio_id = ${pid}`).toHaveLength(2)
    })

    it('work for a team member', async () => {
      const s = await setup()
      const token = await issueMcpBearer(sql, s.teamMember.user.id, ['context.read'])
      const res = await callMcpTool(token, 'read_organization', { org: s.org.slug, portfolio_id: s.hidden.id })
      expect(res.isError, res.content[0]?.text).toBeFalsy()
    })
  })
})
