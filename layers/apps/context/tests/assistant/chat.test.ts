// Assistant conversations end to end, against the AI layer's VITEST fake: the
// prompt each scope builds, on-demand loading through the tools, proposal
// parsing, apply/reject, permission gating, and conversation ownership.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  addContextMember,
  createContextUser,
  addTestMembership,
  getAuthHeaders,
  createTestPortfolio,
  seedTestSection,
  withOrgHeader,
  primeAiFake,
  resetAiFake,
  getAiFakeLog,
  sectionUpdateBlock
} from '../helpers'

// The prompt is sent as text parts; join them for assertions.
function systemText(call: { system?: unknown }): string {
  const s = call.system
  if (typeof s === 'string') return s
  return Array.isArray(s) ? s.map(p => String(p.text)).join('') : ''
}

interface Conversation {
  id: string
  portfolio_id: string | null
  section_key: string | null
  title: string
}
interface Proposal {
  portfolio_slug: string
  portfolio_name: string
  section_key: string
  section_title: string
  current_content: string
  proposed_content: string
  status: 'pending' | 'applied' | 'rejected'
}
interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  proposals: Proposal[]
  context_loaded: string[]
}
interface Turn {
  user_message: Message
  assistant_message: Message
  can_apply: boolean
}

type Opts = ReturnType<typeof withOrgHeader>

async function startConversation(opts: Opts, body: Record<string, string> = {}): Promise<Conversation> {
  const res = await $fetch<{ conversation: Conversation }>('/api/context/assistant/conversations', {
    method: 'POST',
    body,
    ...opts
  })
  return res.conversation
}

async function sendMessage(opts: Opts, conversationId: string, message: string): Promise<Turn> {
  return await $fetch<Turn>(`/api/context/assistant/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { message },
    ...opts
  })
}

async function decide(opts: Opts, conversationId: string, messageId: string, index: number, action: 'apply' | 'reject') {
  return await $fetch<{ proposal: Proposal, version_id?: string }>(`/api/context/assistant/conversations/${conversationId}/proposals`, {
    method: 'POST',
    body: { message_id: messageId, index, action },
    ...opts
  })
}

describe('assistant conversations', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => { await resetAiFake() })
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('portfolio scope preloads every section and parses proposals out of the reply', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Acme Portfolio', created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'identity', content: 'Old identity text' })
    await primeAiFake({
      text: `Here is a suggested update:\n\n${sectionUpdateBlock({ section_key: 'identity', section_title: 'Identity', content: 'We are now Acme.' })}`
    })

    const conv = await startConversation(opts, { portfolio: p.slug })
    expect(conv.portfolio_id).toBe(p.id)
    expect(conv.section_key).toBeNull()

    const turn = await sendMessage(opts, conv.id, 'Update identity')
    expect(turn.can_apply).toBe(true)
    expect(turn.user_message.role).toBe('user')
    expect(turn.assistant_message.content).toBe('Here is a suggested update:')
    expect(turn.assistant_message.proposals).toHaveLength(1)
    expect(turn.assistant_message.proposals[0]).toMatchObject({
      portfolio_slug: p.slug,
      portfolio_name: 'Acme Portfolio',
      section_key: 'identity',
      section_title: 'Identity',
      current_content: 'Old identity text',
      proposed_content: 'We are now Acme.',
      status: 'pending'
    })
    expect(turn.assistant_message.context_loaded).toEqual(['Identity'])

    const log = await getAiFakeLog()
    const call = log.at(-1)!
    expect(call.kind).toBe('complete')
    expect(systemText(call)).toContain('Old identity text')
    expect(systemText(call)).toContain('Acme Portfolio')
    expect(call.tools).toEqual([])
    expect(call.messages.at(-1)).toEqual({ role: 'user', content: 'Update identity' })

    const detail = await $fetch<{ conversation: Conversation, messages: Message[] }>(
      `/api/context/assistant/conversations/${conv.id}`, { ...opts }
    )
    expect(detail.conversation.title).toBe('Update identity')
    expect(detail.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(detail.messages[1]!.proposals[0]!.status).toBe('pending')
  })

  it('logs the assistant\'s spend per portfolio, named on the AI spend page', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Acme Portfolio', created_by: user.id })
    await primeAiFake({ text: 'Hi.' })
    await sendMessage(opts, (await startConversation(opts, { portfolio: p.slug })).id, 'Hello')
    await sendMessage(opts, (await startConversation(opts)).id, 'Hello')
    const subject = `context-portfolio:${p.id}`
    expect((await getAiFakeLog()).filter(c => c.kind === 'complete').map(c => c.subject)).toEqual([subject, 'context-portfolio:all'])

    await sql`
      INSERT INTO ai_usage (org_id, feature, subject, model, provider, key_source, cost)
      VALUES (${org.id}, 'context.assistant', ${subject}, 'test/alpha', 'openrouter', 'host', 1),
             (${org.id}, 'context.assistant', 'context-portfolio:all', 'test/alpha', 'openrouter', 'host', 2)
    `
    const usage = await $fetch<{ by: { subject: { key: string, label: string }[] } }>('/api/ai/org/usage', { ...opts })
    expect(usage.by.subject.map(s => [s.key, s.label])).toEqual([['context-portfolio:all', 'All portfolios'], [subject, 'Acme Portfolio']])
  })

  it('applying a proposal writes the section with a version and records the decision', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    await primeAiFake({ text: sectionUpdateBlock({ section_key: 'identity', section_title: 'Identity', content: 'NEW IDENTITY' }) })

    const conv = await startConversation(opts, { portfolio: p.slug })
    const turn = await sendMessage(opts, conv.id, 'Set identity')
    const msg = turn.assistant_message

    const applied = await decide(opts, conv.id, msg.id, 0, 'apply')
    expect(applied.proposal.status).toBe('applied')
    expect(applied.version_id).toBeDefined()

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM context_sections WHERE portfolio_id = ${p.id} AND section_key = 'identity'
    `
    expect(rows[0]!.content).toBe('NEW IDENTITY')
    const versions = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM context_section_versions v
      JOIN context_sections s ON s.id = v.section_id
      WHERE s.portfolio_id = ${p.id} AND s.section_key = 'identity'
    `
    expect(versions[0]!.n).toBe(1)
    const appliedVersion = await sql<{ source: string | null }[]>`
      SELECT source FROM context_section_versions WHERE id = ${applied.version_id!}
    `
    expect(appliedVersion[0]!.source).toBe('assistant')

    const again = await decide(opts, conv.id, msg.id, 0, 'apply').catch(e => e)
    expect(again.statusCode).toBe(409)
  })

  it('rejecting a proposal leaves the section untouched', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'team', content: 'Keep me' })
    await primeAiFake({ text: sectionUpdateBlock({ section_key: 'team', section_title: 'Team', content: 'Replace me' }) })

    const conv = await startConversation(opts, { portfolio: p.slug })
    const turn = await sendMessage(opts, conv.id, 'Change the team')
    const res = await decide(opts, conv.id, turn.assistant_message.id, 0, 'reject')
    expect(res.proposal.status).toBe('rejected')

    const rows = await sql<{ content: string }[]>`
      SELECT content FROM context_sections WHERE portfolio_id = ${p.id} AND section_key = 'team'
    `
    expect(rows[0]!.content).toBe('Keep me')
  })

  it('section scope preloads one section and loads others through the tools', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'identity', content: 'IDENTITY BODY' })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'team', content: 'TEAM BODY' })
    await primeAiFake({
      text: 'Loaded the team.',
      toolCalls: [
        { name: 'load_section', input: { section_key: 'team' } },
        { name: 'load_section', input: { section_key: 'team' } },
        { name: 'load_section', input: { section_key: 'nope' } }
      ]
    })

    const conv = await startConversation(opts, { portfolio: p.slug, section: 'identity' })
    expect(conv.section_key).toBe('identity')
    const turn = await sendMessage(opts, conv.id, 'Who is on the team?')

    const call = (await getAiFakeLog()).at(-1)!
    expect(systemText(call)).toContain('IDENTITY BODY')
    expect(systemText(call)).not.toContain('TEAM BODY')
    expect(systemText(call)).toContain('focused on the "Identity" section')
    expect(call.tools).toEqual(['load_section', 'load_portfolio', 'search_sections'])
    expect(call.toolResults[0]!.result).toContain('TEAM BODY')
    expect(call.toolResults[1]!.result).toContain('already loaded')
    expect(call.toolResults[2]!.result).toContain('unknown section key')
    expect(turn.assistant_message.context_loaded).toEqual(['Identity', 'Team'])
  })

  it('all-portfolios scope loads a portfolio on demand and proposals name their portfolio', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const a = await createTestPortfolio(sql, { org_id: org.id, name: 'Alpha Org', created_by: user.id })
    const b = await createTestPortfolio(sql, { org_id: org.id, name: 'Beta Org', created_by: user.id })
    await seedTestSection(sql, { portfolio_id: a.id, section_key: 'team', content: 'ALPHA TEAM' })
    await seedTestSection(sql, { portfolio_id: b.id, section_key: 'team', content: 'BETA TEAM' })
    await primeAiFake({
      text: `Updating Beta.\n\n${sectionUpdateBlock({ portfolio: b.slug, section_key: 'team', section_title: 'Team', content: 'BETA TEAM v2' })}`,
      toolCalls: [{ name: 'load_portfolio', input: { portfolio: b.slug } }]
    })

    const conv = await startConversation(opts)
    expect(conv.portfolio_id).toBeNull()
    const turn = await sendMessage(opts, conv.id, 'Refresh the Beta team')

    const call = (await getAiFakeLog()).at(-1)!
    expect(systemText(call)).toContain(`slug: \`${a.slug}\``)
    expect(systemText(call)).toContain(`slug: \`${b.slug}\``)
    expect(systemText(call)).not.toContain('ALPHA TEAM')
    expect(systemText(call)).not.toContain('BETA TEAM')
    expect(call.tools).toEqual(['load_section', 'load_portfolio', 'search_sections'])
    expect(call.toolResults[0]!.result).toContain('BETA TEAM')
    expect(turn.assistant_message.context_loaded).toEqual(['Beta Org › Team'])

    const proposal = turn.assistant_message.proposals[0]!
    expect(proposal.portfolio_slug).toBe(b.slug)
    expect(proposal.current_content).toBe('BETA TEAM')

    await decide(opts, conv.id, turn.assistant_message.id, 0, 'apply')
    const rows = await sql<{ portfolio_id: string, content: string }[]>`
      SELECT portfolio_id, content FROM context_sections WHERE section_key = 'team' AND portfolio_id IN (${a.id}, ${b.id})
    `
    expect(rows.find(r => r.portfolio_id === b.id)!.content).toBe('BETA TEAM v2')
    expect(rows.find(r => r.portfolio_id === a.id)!.content).toBe('ALPHA TEAM')
  })

  it('a block naming an unknown portfolio or section is ignored', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    await primeAiFake({
      text: [
        sectionUpdateBlock({ portfolio: 'not-a-portfolio', section_key: 'team', section_title: 'Team', content: 'x' }),
        sectionUpdateBlock({ section_key: 'not-a-section', section_title: 'Nope', content: 'y' })
      ].join('\n\n')
    })
    const conv = await startConversation(opts, { portfolio: p.slug })
    const turn = await sendMessage(opts, conv.id, 'hi')
    expect(turn.assistant_message.proposals).toEqual([])
    expect(turn.assistant_message.content).toBe('')
  })

  it('a member without context.assistant.apply chats in view-only mode', async () => {
    const { org, user } = await createContextOrgWith(sql, ['admin'])
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    const roleName = `test-context-chatter-${randomUUID().slice(0, 8)}`
    await sql`
      INSERT INTO custom_roles (name, permissions, org_id)
      VALUES (${roleName}, ${sql.array(['context.access', 'context.read', 'context.write', 'context.assistant.chat'])}, ${org.id})
    `
    const chatter = await createContextUser(sql)
    await addTestMembership(sql, { user_id: chatter.id, org_id: org.id, roles: [roleName] })
    const opts = withOrgHeader(getAuthHeaders(chatter), org.slug)
    await primeAiFake({ text: `Sure.\n\n${sectionUpdateBlock({ section_key: 'identity', section_title: 'Identity', content: 'X' })}` })

    const conv = await startConversation(opts, { portfolio: p.slug })
    const turn = await sendMessage(opts, conv.id, 'Change identity')
    expect(turn.can_apply).toBe(false)
    expect(turn.assistant_message.proposals).toEqual([])
    expect(systemText((await getAiFakeLog()).at(-1)!)).toContain('view-only')
  })

  it('conversations are private to their owner and listed per scope', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })
    const member = await addContextMember(sql, org.id, ['member'])
    const memberOpts = withOrgHeader(member.auth, org.slug)

    const conv = await startConversation(opts, { portfolio: p.slug })
    await primeAiFake({ text: 'ok' })
    await sendMessage(opts, conv.id, 'first')

    const other = await $fetch(`/api/context/assistant/conversations/${conv.id}`, { ...memberOpts }).catch(e => e)
    expect(other.statusCode).toBe(404)

    const mine = await $fetch<{ conversations: Array<Conversation & { message_count: number }> }>(
      `/api/context/assistant/conversations?portfolio=${p.slug}`, { ...opts }
    )
    expect(mine.conversations.map(c => c.id)).toEqual([conv.id])
    expect(mine.conversations[0]!.message_count).toBe(2)

    const theirs = await $fetch<{ conversations: Conversation[] }>(
      `/api/context/assistant/conversations?portfolio=${p.slug}`, { ...memberOpts }
    )
    expect(theirs.conversations).toEqual([])

    const workspaceScope = await $fetch<{ conversations: Conversation[] }>(
      '/api/context/assistant/conversations', { ...opts }
    )
    expect(workspaceScope.conversations).toEqual([])

    await $fetch(`/api/context/assistant/conversations/${conv.id}`, { method: 'DELETE', ...opts })
    const gone = await $fetch(`/api/context/assistant/conversations/${conv.id}`, { ...opts }).catch(e => e)
    expect(gone.statusCode).toBe(404)
  })

  it('validates the scope when starting a conversation', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, created_by: user.id })

    const noPortfolio = await startConversation(opts, { section: 'identity' }).catch(e => e)
    expect(noPortfolio.statusCode).toBe(400)
    const badSection = await startConversation(opts, { portfolio: p.slug, section: 'nope' }).catch(e => e)
    expect(badSection.statusCode).toBe(404)
    const badPortfolio = await startConversation(opts, { portfolio: 'missing' }).catch(e => e)
    expect(badPortfolio.statusCode).toBe(404)
  })
})

describe('assistant and deleted sections', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => { await resetAiFake() })
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('portfolio scope preloads only sections the portfolio still has', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Pruned', created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'identity', content: 'Identity text stays' })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'team', content: 'Team text is orphaned' })
    await $fetch(`/api/context/portfolios/${p.slug}/sections/team`, { method: 'DELETE', ...opts })
    await primeAiFake({ text: 'Sure.' })

    const conv = await startConversation(opts, { portfolio: p.slug })
    const turn = await sendMessage(opts, conv.id, 'What do you know?')
    expect(turn.assistant_message.context_loaded).toEqual(['Identity'])

    const call = (await getAiFakeLog()).at(-1)!
    expect(systemText(call)).toContain('Identity text stays')
    expect(systemText(call)).not.toContain('Team text is orphaned')
  })
})
