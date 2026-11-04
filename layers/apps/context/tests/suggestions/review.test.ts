// Suggest mode end to end: MCP update calls on sections with content become
// pending suggestions, reviewers approve or reject them over HTTP, and
// suggesters follow up through MCP. Runs in multi-tenant mode with every
// permission coming from org memberships.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  addContextMember,
  createTestPortfolio,
  seedTestSection,
  issueMcpBearer,
  callMcpTool,
  withOrgHeader
} from '../helpers'

const sql = getHostAdminDb()

// An org with an admin (the reviewer) and a member (the suggester, who holds
// context.write but not context.suggestion.review). `identity` has content;
// `team` is empty.
async function setup() {
  const { org, user: admin, auth: adminAuth } = await createContextOrgWith(sql, ['admin'])
  const { user: member, auth: memberAuth } = await addContextMember(sql, org.id, ['member'])
  const portfolio = await createTestPortfolio(sql, { org_id: org.id, name: 'Suggest', created_by: admin.id })
  await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'identity', content: 'Original identity.', last_edited_by: admin.id })
  const token = await issueMcpBearer(sql, member.id, ['context.read', 'context.write'])
  return { org, admin, adminAuth, member, memberAuth, portfolio, token }
}

async function content(portfolioId: string, key: string): Promise<string | null> {
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM context_sections WHERE portfolio_id = ${portfolioId} AND section_key = ${key}
  `
  return rows[0]?.content ?? null
}

async function suggestions(setId: string) {
  return await sql<{ id: string, section_key: string, status: string, base_content: string, proposed_content: string }[]>`
    SELECT id, section_key, status, base_content, proposed_content
    FROM context_suggestions WHERE set_id = ${setId} ORDER BY created_at
  `
}

describe('context suggest mode', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('update_section on a section with content suggests instead of writing', async () => {
    const { org, portfolio, token } = await setup()

    const res = await callMcpTool(token, 'update_section', {
      org: org.slug,
      portfolio_id: portfolio.id,
      section_key: 'identity',
      content: 'Rewritten identity.',
      note: 'Tightened wording'
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    expect(res.structuredContent).toMatchObject({ key: 'identity', status: 'suggested' })
    expect(res.content[0]?.text).toContain('Pending review')

    expect(await content(portfolio.id, 'identity')).toBe('Original identity.')
    const setId = res.structuredContent?.suggestion_set_id as string
    const rows = await suggestions(setId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: res.structuredContent?.suggestion_id,
      status: 'pending',
      base_content: 'Original identity.',
      proposed_content: 'Rewritten identity.'
    })
    const [set] = await sql<{ note: string }[]>`SELECT note FROM context_suggestion_sets WHERE id = ${setId}`
    expect(set!.note).toBe('Tightened wording')
  })

  it('writes empty sections immediately and honors mode direct', async () => {
    const { org, portfolio, token } = await setup()

    const empty = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'team', content: 'Alice and Bob.'
    })
    expect(empty.structuredContent).toMatchObject({ key: 'team', status: 'updated' })
    expect(await content(portfolio.id, 'team')).toBe('Alice and Bob.')

    const direct = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Direct.', mode: 'direct'
    })
    expect(direct.structuredContent).toMatchObject({ key: 'identity', status: 'updated' })
    expect(await content(portfolio.id, 'identity')).toBe('Direct.')

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM context_suggestions WHERE portfolio_id = ${portfolio.id}
    ` as unknown as [{ count: string }]
    expect(count).toBe('0')
  })

  it('bulk_update_sections applies empty sections and groups the rest into one set', async () => {
    const { org, admin, portfolio, token } = await setup()
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'Old vision.', last_edited_by: admin.id })

    const res = await callMcpTool(token, 'bulk_update_sections', {
      org: org.slug,
      portfolio_id: portfolio.id,
      updates: [
        { section_key: 'identity', content: 'New identity.' },
        { section_key: 'team', content: 'New team.' },
        { section_key: 'vision-and-values', content: 'New vision.' },
        { section_key: 'vision-and-values', content: 'Newer vision.' }
      ]
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const results = res.structuredContent?.results as Array<Record<string, unknown>>
    expect(results.map(r => [r.key, r.status])).toEqual([
      ['identity', 'suggested'],
      ['team', 'updated'],
      ['vision-and-values', 'suggested'],
      ['vision-and-values', 'suggested']
    ])
    expect(await content(portfolio.id, 'team')).toBe('New team.')
    expect(await content(portfolio.id, 'vision-and-values')).toBe('Old vision.')

    const setId = res.structuredContent?.suggestion_set_id as string
    const rows = await suggestions(setId)
    expect(rows.map(r => [r.section_key, r.status, r.proposed_content])).toEqual([
      ['identity', 'pending', 'New identity.'],
      ['vision-and-values', 'superseded', 'New vision.'],
      ['vision-and-values', 'pending', 'Newer vision.']
    ])
  })

  it('a new suggestion from the same author supersedes the earlier one; other authors stack', async () => {
    const { org, admin, portfolio, token } = await setup()
    const adminToken = await issueMcpBearer(sql, admin.id, ['context.read', 'context.write'])
    const call = (t: string, c: string) => callMcpTool(t, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: c
    })

    const first = await call(token, 'First try.')
    const byAdmin = await call(adminToken, 'Admin idea.')
    const second = await call(token, 'Second try.')

    const statuses = await sql<{ id: string, status: string }[]>`
      SELECT id, status FROM context_suggestions WHERE portfolio_id = ${portfolio.id}
    `
    const byId = new Map(statuses.map(r => [r.id, r.status]))
    expect(byId.get(first.structuredContent?.suggestion_id as string)).toBe('superseded')
    expect(byId.get(byAdmin.structuredContent?.suggestion_id as string)).toBe('pending')
    expect(byId.get(second.structuredContent?.suggestion_id as string)).toBe('pending')
  })

  it('a reviewer approves: the section is written as the suggester, linked to the suggestion', async () => {
    const { org, admin, adminAuth, member, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Approved text.'
    })
    const setId = res.structuredContent?.suggestion_set_id as string
    const suggestionId = res.structuredContent?.suggestion_id as string

    const decided = await $fetch<{ set: { suggestions: Array<{ status: string }> } }>(
      `/api/context/suggestions/${setId}/decide`,
      { method: 'POST', body: { action: 'approve' }, ...withOrgHeader(adminAuth, org.slug) }
    )
    expect(decided.set.suggestions[0]!.status).toBe('approved')
    expect(await content(portfolio.id, 'identity')).toBe('Approved text.')

    const versions = await sql<{ edited_by: string, source: string, suggestion_id: string }[]>`
      SELECT v.edited_by, v.source, v.suggestion_id
      FROM context_section_versions v
      JOIN context_sections s ON s.id = v.section_id
      WHERE s.portfolio_id = ${portfolio.id} AND s.section_key = 'identity'
    `
    expect(versions).toEqual([{ edited_by: member.id, source: 'suggestion', suggestion_id: suggestionId }])

    const [row] = await sql<{ decided_by: string }[]>`SELECT decided_by FROM context_suggestions WHERE id = ${suggestionId}`
    expect(row!.decided_by).toBe(admin.id)

    await expect($fetch(
      `/api/context/suggestions/${setId}/decide`,
      { method: 'POST', body: { action: 'approve' }, ...withOrgHeader(adminAuth, org.slug) }
    )).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a reviewer approves with edits: the edited content is written as the reviewer', async () => {
    const { org, admin, adminAuth, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Suggested text.'
    })
    const setId = res.structuredContent?.suggestion_set_id as string
    const suggestionId = res.structuredContent?.suggestion_id as string

    await expect($fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'approve', content: 'Edited.' }, ...withOrgHeader(adminAuth, org.slug)
    })).rejects.toMatchObject({ statusCode: 400 })

    const decided = await $fetch<{ set: { suggestions: Array<{ status: string, proposed_content: string }> } }>(
      `/api/context/suggestions/${setId}/decide`,
      {
        method: 'POST',
        body: { action: 'approve', suggestion_ids: [suggestionId], content: 'Suggested text, tidied.' },
        ...withOrgHeader(adminAuth, org.slug)
      }
    )
    expect(decided.set.suggestions[0]).toMatchObject({ status: 'approved', proposed_content: 'Suggested text.' })
    expect(await content(portfolio.id, 'identity')).toBe('Suggested text, tidied.')

    const versions = await sql<{ edited_by: string, source: string, suggestion_id: string, content: string }[]>`
      SELECT v.edited_by, v.source, v.suggestion_id, v.content
      FROM context_section_versions v
      JOIN context_sections s ON s.id = v.section_id
      WHERE s.portfolio_id = ${portfolio.id} AND s.section_key = 'identity'
    `
    expect(versions).toEqual([{ edited_by: admin.id, source: 'suggestion', suggestion_id: suggestionId, content: 'Suggested text, tidied.' }])
  })

  it('flags a suggestion whose section changed since, and approval still overwrites', async () => {
    const { org, adminAuth, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Suggested.'
    })
    const setId = res.structuredContent?.suggestion_set_id as string
    await $fetch(`/api/context/portfolios/${portfolio.slug}/sections/identity`, {
      method: 'PUT', body: { content: 'Edited in the web.' }, ...withOrgHeader(adminAuth, org.slug)
    })

    const detail = await $fetch<{ set: { suggestions: Array<{ stale: boolean, current_content: string, base_content: string }> } }>(
      `/api/context/suggestions/${setId}`, { ...withOrgHeader(adminAuth, org.slug) }
    )
    expect(detail.set.suggestions[0]).toMatchObject({
      stale: true,
      current_content: 'Edited in the web.',
      base_content: 'Original identity.'
    })

    const queue = await $fetch<{ sets: Array<{ id: string, stale_count: number }> }>(
      '/api/context/suggestions', { ...withOrgHeader(adminAuth, org.slug) }
    )
    expect(queue.sets.find(s => s.id === setId)?.stale_count).toBe(1)

    await $fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'approve' }, ...withOrgHeader(adminAuth, org.slug)
    })
    expect(await content(portfolio.id, 'identity')).toBe('Suggested.')
  })

  it('a rejection note reaches the suggester through list_suggestions', async () => {
    const { org, adminAuth, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Nope.'
    })
    const setId = res.structuredContent?.suggestion_set_id as string
    await $fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'reject', note: 'Too vague.' }, ...withOrgHeader(adminAuth, org.slug)
    })
    expect(await content(portfolio.id, 'identity')).toBe('Original identity.')

    const listed = await callMcpTool(token, 'list_suggestions', { org: org.slug })
    expect(listed.isError, listed.content[0]?.text).toBeFalsy()
    const list = listed.structuredContent?.suggestions as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: res.structuredContent?.suggestion_id, status: 'rejected', review_note: 'Too vague.' })
  })

  it('members without the review permission can only see and withdraw their own suggestions', async () => {
    const { org, admin, memberAuth, portfolio, token } = await setup()
    const own = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Mine.'
    })
    const ownSetId = own.structuredContent?.suggestion_set_id as string
    const adminToken = await issueMcpBearer(sql, admin.id, ['context.read', 'context.write'])
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'V.', last_edited_by: admin.id })
    const other = await callMcpTool(adminToken, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'Theirs.'
    })
    const otherSetId = other.structuredContent?.suggestion_set_id as string

    const queue = await $fetch<{ sets: Array<{ id: string }> }>('/api/context/suggestions', { ...withOrgHeader(memberAuth, org.slug) })
    expect(queue.sets.map(s => s.id)).toEqual([ownSetId])

    await expect($fetch(`/api/context/suggestions/${otherSetId}`, { ...withOrgHeader(memberAuth, org.slug) }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect($fetch('/api/context/suggestions/not-a-uuid', { ...withOrgHeader(memberAuth, org.slug) }))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect($fetch(`/api/context/suggestions/${ownSetId}/decide`, {
      method: 'POST', body: { action: 'approve' }, ...withOrgHeader(memberAuth, org.slug)
    })).rejects.toMatchObject({ statusCode: 403 })

    const read = await callMcpTool(token, 'read_section', { org: org.slug, portfolio_id: portfolio.id, section_key: 'identity' })
    expect(read.structuredContent?.pending_suggestion_id).toBe(own.structuredContent?.suggestion_id)

    const withdrawn = await callMcpTool(token, 'withdraw_suggestion', {
      org: org.slug, suggestion_id: own.structuredContent?.suggestion_id
    })
    expect(withdrawn.structuredContent).toMatchObject({ status: 'withdrawn' })
    const notMine = await callMcpTool(token, 'withdraw_suggestion', {
      org: org.slug, suggestion_id: other.structuredContent?.suggestion_id
    })
    expect(notMine.isError).toBe(true)
  })

  it('notifies reviewers with a digest notification linking to the set', async () => {
    const { org, admin, member, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Ping.'
    })
    const setId = res.structuredContent?.suggestion_set_id as string

    const rows = await sql<{ user_id: string, app_id: string, link: string, email_mode: string }[]>`
      SELECT user_id, app_id, link, email_mode FROM notifications WHERE org_id = ${org.id}
    `
    expect(rows).toEqual([{ user_id: admin.id, app_id: 'context', link: `/context/suggestions/${setId}`, email_mode: 'digest' }])
    expect(rows.some(r => r.user_id === member.id)).toBe(false)
  })

  it('update_suggestion revises a pending section in place and adds new sections to the same set', async () => {
    const { org, admin, portfolio, token } = await setup()
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'V.', last_edited_by: admin.id })
    const first = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Draft one.', note: 'First pass'
    })
    const setId = first.structuredContent?.suggestion_set_id as string
    const read = await callMcpTool(token, 'read_section', { org: org.slug, portfolio_id: portfolio.id, section_key: 'identity' })
    expect(read.structuredContent?.pending_suggestion_set_id).toBe(setId)

    const res = await callMcpTool(token, 'update_suggestion', {
      org: org.slug,
      suggestion_set_id: setId,
      updates: [
        { section_key: 'identity', content: 'Draft two.' },
        { section_key: 'vision-and-values', content: 'Sharper vision.' }
      ],
      note: 'Second pass'
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    expect(res.structuredContent?.results).toEqual([
      { id: first.structuredContent?.suggestion_id, key: 'identity', status: 'revised' },
      expect.objectContaining({ key: 'vision-and-values', status: 'added' })
    ])

    expect((await suggestions(setId)).map(r => [r.section_key, r.status, r.base_content, r.proposed_content])).toEqual([
      ['identity', 'pending', 'Original identity.', 'Draft two.'],
      ['vision-and-values', 'pending', 'V.', 'Sharper vision.']
    ])
    const [set] = await sql<{ note: string }[]>`SELECT note FROM context_suggestion_sets WHERE id = ${setId}`
    expect(set!.note).toBe('Second pass')
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM context_suggestion_sets WHERE portfolio_id = ${portfolio.id}
    ` as unknown as [{ count: string }]
    expect(count).toBe('1')

    const shown = await callMcpTool(token, 'read_suggestion', { org: org.slug, suggestion_set_id: setId })
    expect(shown.isError, shown.content[0]?.text).toBeFalsy()
    expect((shown.structuredContent?.suggestions as Array<Record<string, unknown>>).map(s => s.proposed_content))
      .toEqual(['Draft two.', 'Sharper vision.'])
  })

  it('update_suggestion only touches the caller\'s own open sets', async () => {
    const { org, admin, adminAuth, portfolio, token } = await setup()
    const adminToken = await issueMcpBearer(sql, admin.id, ['context.read', 'context.write'])
    const mine = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'Mine.'
    })
    const setId = mine.structuredContent?.suggestion_set_id as string

    const byOther = await callMcpTool(adminToken, 'update_suggestion', {
      org: org.slug, suggestion_set_id: setId, note: 'hijack'
    })
    expect(byOther.isError).toBe(true)

    await $fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'reject' }, ...withOrgHeader(adminAuth, org.slug)
    })
    const afterDecision = await callMcpTool(token, 'update_suggestion', {
      org: org.slug, suggestion_set_id: setId, updates: [{ section_key: 'identity', content: 'Too late.' }]
    })
    expect(afterDecision.isError).toBe(true)
    expect((await suggestions(setId))[0]!.proposed_content).toBe('Mine.')
  })

  it('opening a set marks only the viewer\'s notifications about it read', async () => {
    const { org, admin, adminAuth, portfolio, token } = await setup()
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'V.', last_edited_by: admin.id })
    const a = await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'identity', content: 'A.'
    })
    await callMcpTool(token, 'update_section', {
      org: org.slug, portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'B.'
    })
    const setA = a.structuredContent?.suggestion_set_id as string

    await $fetch(`/api/context/suggestions/${setA}/read`, { method: 'POST', ...withOrgHeader(adminAuth, org.slug) })

    const rows = await sql<{ link: string, read: boolean }[]>`
      SELECT link, read_at IS NOT NULL AS read FROM notifications
      WHERE user_id = ${admin.id} AND app_id = 'context' ORDER BY created_at
    `
    expect(rows.map(r => [r.link === `/context/suggestions/${setA}`, r.read])).toEqual([[true, true], [false, false]])
  })

  it('once nothing in a set is pending, every reviewer\'s notification about it is read', async () => {
    const { org, admin, adminAuth, portfolio, token } = await setup()
    const { user: reviewer } = await addContextMember(sql, org.id, ['admin'])
    await seedTestSection(sql, { portfolio_id: portfolio.id, section_key: 'vision-and-values', content: 'V.', last_edited_by: admin.id })
    const res = await callMcpTool(token, 'bulk_update_sections', {
      org: org.slug,
      portfolio_id: portfolio.id,
      updates: [
        { section_key: 'identity', content: 'A.' },
        { section_key: 'vision-and-values', content: 'B.' }
      ]
    })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const setId = res.structuredContent?.suggestion_set_id as string
    const [first, second] = await suggestions(setId)

    const readByUser = async () => new Map((await sql<{ user_id: string, read: boolean }[]>`
      SELECT user_id, read_at IS NOT NULL AS read FROM notifications
      WHERE link = ${`/context/suggestions/${setId}`}
    `).map(r => [r.user_id, r.read]))

    await $fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'approve', suggestion_ids: [first!.id] }, ...withOrgHeader(adminAuth, org.slug)
    })
    expect(await readByUser()).toEqual(new Map([[admin.id, false], [reviewer.id, false]]))

    await $fetch(`/api/context/suggestions/${setId}/decide`, {
      method: 'POST', body: { action: 'reject', suggestion_ids: [second!.id] }, ...withOrgHeader(adminAuth, org.slug)
    })
    expect(await readByUser()).toEqual(new Map([[admin.id, true], [reviewer.id, true]]))
  })

  it('a failing bulk call leaves no suggestion behind', async () => {
    const { org, portfolio, token } = await setup()
    const res = await callMcpTool(token, 'bulk_update_sections', {
      org: org.slug,
      portfolio_id: portfolio.id,
      updates: [
        { section_key: 'identity', content: 'fine' },
        { section_key: 'team', content: 'x'.repeat(100 * 1024 + 1) }
      ]
    })
    expect(res.isError).toBe(true)
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM context_suggestion_sets WHERE portfolio_id = ${portfolio.id}
    ` as unknown as [{ count: string }]
    expect(count).toBe('0')
  })
})
