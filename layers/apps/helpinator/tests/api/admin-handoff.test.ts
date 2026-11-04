// Admin API (widgets CRUD, conversation log, permissions) and the visitor's
// "still need help?" handoff into the inbox.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  addHelpinatorMember,
  seedPortfolio,
  seedLibrary,
  seedWidget,
  sendTurn,
  primeAiFake,
  resetAiFake,
  widgetHeaders,
  SITE_ORIGIN
} from '../helpers'

describe('admin + handoff', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })

  it('creates and updates a widget; rebinding ends open conversations', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const a = await seedPortfolio(sql, org.id, 'A', { faq: 'A content' })
    const b = await seedPortfolio(sql, org.id, 'B', { intro: 'B content' })
    const la = await seedLibrary(sql, { orgId: org.id, portfolioId: a.id })
    const lb = await seedLibrary(sql, { orgId: org.id, portfolioId: b.id })
    const body = {
      name: 'Site',
      library_ids: [la.id],
      default_library_id: la.id,
      default_section_key: 'faq',
      allowed_origins: [`${SITE_ORIGIN}/some/path`],
      // position is sent at its default value, as an older form would.
      appearance: { primary_color: '#FF0000', title: 'Help!', position: 'bottom-right', bogus: 'dropped' }
    }
    const w = await $fetch<{ id: string, allowed_origins: string[], appearance: Record<string, string> }>(
      '/api/helpinator/widgets', { method: 'POST', body, ...opts })
    expect(w.allowed_origins).toEqual([SITE_ORIGIN])
    expect(w.appearance.primary_color).toBe('#ff0000')
    expect(w.appearance.title).toBe('Help!')
    expect(w.appearance).not.toHaveProperty('bogus')
    // Only overrides are stored: a value equal to the default keeps following it.
    const [stored] = await sql`SELECT appearance FROM helpinator_widgets WHERE id = ${w.id}`
    expect(stored!.appearance).toEqual({ primary_color: '#ff0000', title: 'Help!' })

    await primeAiFake({ text: 'hi' })
    const turn = await sendTurn(w.id, 'hello')

    await $fetch(`/api/helpinator/widgets/${w.id}`, {
      method: 'PUT', body: { ...body, library_ids: [lb.id], default_library_id: lb.id, default_section_key: 'intro' }, ...opts
    })
    const [row] = await sql`SELECT ended_at FROM helpinator_conversations WHERE id = ${turn.conversationId}`
    expect(row!.ended_at).not.toBeNull()
  })

  it('stores suggested questions cleaned up and serves them in the public config', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const lw = await seedLibrary(sql, { orgId: org.id, kind: 'website' })
    const body = { name: 'S', library_ids: [lw.id], default_library_id: lw.id, allowed_origins: [SITE_ORIGIN] }
    const w = await $fetch<{ id: string, starter_questions: string[] }>('/api/helpinator/widgets', {
      method: 'POST', body: { ...body, starter_questions: ['  When do you open? ', '', 'When do you open?', 'Where are you?'] }, ...opts
    })
    expect(w.starter_questions).toEqual(['When do you open?', 'Where are you?'])
    const cfg = await $fetch<{ starterQuestions: string[] }>(`/api/v1/helpinator/widgets/${w.id}/config`, { headers: widgetHeaders() })
    expect(cfg.starterQuestions).toEqual(['When do you open?', 'Where are you?'])

    const tooMany = await $fetch(`/api/helpinator/widgets/${w.id}`, {
      method: 'PUT', body: { ...body, starter_questions: Array.from({ length: 7 }, (_, i) => `Q${i}`) }, ...opts
    }).catch(e => e)
    expect(tooMany.statusCode).toBe(400)
  })

  it('rejects a section that is not in the default library\'s portfolio, and a default outside the list', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const a = await seedPortfolio(sql, org.id, 'A', { faq: 'x' })
    const la = await seedLibrary(sql, { orgId: org.id, portfolioId: a.id })
    const lw = await seedLibrary(sql, { orgId: org.id, kind: 'website' })
    const bad = await $fetch('/api/helpinator/widgets', {
      method: 'POST', body: { name: 'S', library_ids: [la.id], default_library_id: la.id, default_section_key: 'nope' }, ...opts
    }).catch(e => e)
    expect(bad.statusCode).toBe(400)
    const notListed = await $fetch('/api/helpinator/widgets', {
      method: 'POST', body: { name: 'S', library_ids: [la.id], default_library_id: lw.id }, ...opts
    }).catch(e => e)
    expect(notListed.statusCode).toBe(400)
  })

  it('members without helpinator permissions are refused', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const { opts } = await addHelpinatorMember(sql, org)
    expect((await $fetch('/api/helpinator/conversations', opts).catch(e => e)).statusCode).toBe(403)
    expect((await $fetch('/api/helpinator/widgets', { method: 'POST', body: {}, ...opts }).catch(e => e)).statusCode).toBe(403)
  })

  it('lists conversations with the first question, and shows a transcript', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'answer' })
    const turn = await sendTurn(widget.id, 'my question')

    const list = await $fetch<{ conversations: { id: string, first_question: string }[] }>('/api/helpinator/conversations', opts)
    expect(list.conversations[0]!.first_question).toBe('my question')

    const detail = await $fetch<{ messages: { role: string, pages_loaded: { ref: string }[] }[] }>(
      `/api/helpinator/conversations/${turn.conversationId}`, opts)
    expect(detail.messages).toHaveLength(2)
    expect(detail.messages[1]!.pages_loaded.map(p => p.ref)).toEqual([`section:${widget.libraryId}:faq`])
  })

  it('steps to the newer and older conversation within the list filter', async () => {
    const { org, opts } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'answer' })
    const ids: string[] = []
    for (const [i, q] of ['oldest', 'middle', 'newest'].entries()) {
      const turn = await sendTurn(widget.id, q)
      await sql`UPDATE helpinator_conversations SET last_message_at = now() - ${`${3 - i} hours`}::interval WHERE id = ${turn.conversationId}`
      ids.push(turn.conversationId)
    }
    const [oldest, middle, newest] = ids as [string, string, string]
    const neighbors = (id: string, query: Record<string, string> = {}) =>
      $fetch<{ prevId: string | null, nextId: string | null }>(`/api/helpinator/conversations/${id}/neighbors`, { query, ...opts })

    expect(await neighbors(middle)).toEqual({ prevId: newest, nextId: oldest })
    expect(await neighbors(newest)).toEqual({ prevId: null, nextId: middle })
    expect(await neighbors(oldest)).toEqual({ prevId: middle, nextId: null })

    await sql`UPDATE helpinator_conversations SET visitor_email = 'v@example.com' WHERE id IN (${oldest}, ${newest})`
    expect(await neighbors(newest, { hasEmail: 'true' })).toEqual({ prevId: null, nextId: oldest })
  })

  it('visitor handoff creates an open, unassigned inbox conversation with the transcript — once', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'I am not sure.' })
    const turn = await sendTurn(widget.id, 'Can I get a refund?')

    const res = await $fetch<{ status: string }>(`/api/v1/helpinator/widgets/${widget.id}/handoff`, {
      method: 'POST', headers: widgetHeaders(turn.token), body: { email: 'visitor@example.com' }
    })
    expect(res.status).toBe('handed_off')

    const [conv] = await sql`SELECT inbox_conversation_id, handoff_kind FROM helpinator_conversations WHERE id = ${turn.conversationId}`
    expect(conv!.handoff_kind).toBe('visitor')
    const [inbox] = await sql`SELECT status, source, assigned_user_id, subject FROM inbox_conversations WHERE id = ${conv!.inbox_conversation_id}`
    expect(inbox).toMatchObject({ status: 'open', source: 'helpinator', assigned_user_id: null })
    // The subject also heads the auto-ack to the typed address: nothing the
    // visitor wrote goes in it.
    expect(inbox!.subject).not.toContain('refund')
    expect(inbox!.subject).toMatch(/^Help chat: /)
    const [msg] = await sql`SELECT body_text FROM inbox_messages WHERE conversation_id = ${conv!.inbox_conversation_id}`
    expect(msg!.body_text).toContain('Can I get a refund?')
    expect(msg!.body_text).toContain('I am not sure.')

    const again = await $fetch<{ status: string }>(`/api/v1/helpinator/widgets/${widget.id}/handoff`, {
      method: 'POST', headers: widgetHeaders(turn.token), body: { email: 'visitor@example.com' }
    })
    expect(again.status).toBe('already_handed_off')
    const count = await sql`SELECT count(*)::int AS n FROM inbox_conversations WHERE source = 'helpinator' AND org_id = ${org.id}`
    expect(count[0]!.n).toBe(1)
  })

  it('limits visitor handoffs per mailbox, whichever client asks and however the address is spelled', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    const local = `target${randomUUID().slice(0, 8)}`
    // All one Gmail mailbox: +tags and dots are ignored on delivery.
    const spellings = [`${local}@gmail.com`, `${local}+1@gmail.com`, `${local.slice(0, 3)}.${local.slice(3)}@googlemail.com`, `${local.toUpperCase()}+x@Gmail.com`]
    const codes: number[] = []
    for (const [i, email] of spellings.entries()) {
      await primeAiFake({ text: 'ok' })
      const turn = await sendTurn(widget.id, `question ${i}`)
      const res = await $fetch<{ status: string }>(`/api/v1/helpinator/widgets/${widget.id}/handoff`, {
        method: 'POST', headers: widgetHeaders(turn.token), body: { email }
      }).catch(e => e)
      codes.push(res.statusCode ?? 200)
    }
    expect(codes).toEqual([200, 200, 200, 429])
  })

  it('refuses handoff when the inbox app is off for the org, and the widget stops offering it', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const p = await seedPortfolio(sql, org.id, 'P', { faq: 'x' })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: p.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'ok' })
    const turn = await sendTurn(widget.id, 'question')
    await sql`UPDATE org_apps SET enabled = false WHERE org_id = ${org.id} AND app_id = 'inbox'`
    try {
      const cfg = await $fetch<{ handoffAvailable: boolean }>(`/api/v1/helpinator/widgets/${widget.id}/config`, { headers: widgetHeaders() })
      expect(cfg.handoffAvailable).toBe(false)
      const res = await $fetch(`/api/v1/helpinator/widgets/${widget.id}/handoff`, {
        method: 'POST', headers: widgetHeaders(turn.token), body: { email: 'visitor@example.com' }
      }).catch(e => e)
      expect(res.statusCode).toBe(503)
      const [conv] = await sql`SELECT inbox_conversation_id FROM helpinator_conversations WHERE id = ${turn.conversationId}`
      expect(conv!.inbox_conversation_id).toBeNull()
    } finally {
      await sql`UPDATE org_apps SET enabled = true WHERE org_id = ${org.id} AND app_id = 'inbox'`
    }
  })
})
