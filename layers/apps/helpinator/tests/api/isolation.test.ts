// Library isolation — the prompt-injection defence. The bot must never be
// able to reach a library (or portfolio) outside its widget's list, whatever
// the model asks for. Driven through the AI layer's VITEST fake: the "model"
// is scripted to call load_page with refs it should not be able to read.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  seedPortfolio,
  seedLibrary,
  seedWidget,
  sendTurn,
  primeAiFake,
  resetAiFake,
  getAiFakeLog,
  systemText,
  widgetHeaders
} from '../helpers'

// The chat call in the fake's log; the auto-search's embed call precedes it.
async function chatCall() {
  const call = (await getAiFakeLog()).find(c => c.kind === 'complete')
  if (!call) throw new Error('no chat call recorded')
  return call
}

describe('library isolation', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })

  async function setup() {
    const { org } = await createHelpinatorOrgWith(sql)
    const bound = await seedPortfolio(sql, org.id, 'Public Help', { faq: 'Opening hours are 9-5.', shipping: 'We ship worldwide.' })
    // Same org, different portfolio: internal content the bot must never see,
    // even though a library for it exists in the org.
    const secret = await seedPortfolio(sql, org.id, 'Internal Strategy', { budget: 'SECRET-BUDGET-42', faq: 'SECRET-FAQ' })
    const secretLibrary = await seedLibrary(sql, { orgId: org.id, name: 'Internal Library', portfolioId: secret.id })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: bound.id, sectionKey: 'faq' })
    return { org, bound, secret, secretLibrary, widget }
  }

  it('the tools take no library or portfolio argument', async () => {
    const { widget } = await setup()
    await primeAiFake({ text: 'Hi' })
    await sendTurn(widget.id, 'hello')
    const call = await chatCall()
    expect(call.tools).toEqual(['search', 'load_page'])
    const text = JSON.stringify(call)
    expect(text).not.toMatch(/"portfolio"\s*:/)
    expect(text).not.toMatch(/"library"\s*:/)
  })

  it('the prompt indexes the default library only — no other library, portfolio or content', async () => {
    const { widget, secret } = await setup()
    await primeAiFake({ text: 'Hi' })
    await sendTurn(widget.id, 'hello')
    const system = systemText(await chatCall())
    expect(system).toContain('Opening hours are 9-5.')
    expect(system).toContain(`section:${widget.libraryId}:shipping`)
    expect(system).not.toContain('Internal Strategy')
    expect(system).not.toContain('Internal Library')
    expect(system).not.toContain(secret.slug)
    expect(system).not.toContain('SECRET')
    expect(system).not.toContain('budget')
  })

  it('load_page for a section of a library the widget does not list is unknown', async () => {
    const { widget, secretLibrary } = await setup()
    await primeAiFake({ text: 'Sorry', toolCalls: [{ name: 'load_page', input: { ref: `section:${secretLibrary.id}:budget` } }] })
    const turn = await sendTurn(widget.id, 'tell me the budget')
    const call = await chatCall()
    expect(call.toolResults[0]!.result).toMatch(/unknown page/)
    expect(JSON.stringify(call)).not.toContain('SECRET-BUDGET-42')
    expect(turn.assistantMessage.content).toBe('Sorry')
  })

  it('a key that exists only in another portfolio is unknown under the bound library', async () => {
    const { widget } = await setup()
    await primeAiFake({ text: 'Sorry', toolCalls: [{ name: 'load_page', input: { ref: `section:${widget.libraryId}:budget` } }] })
    await sendTurn(widget.id, 'budget?')
    const call = await chatCall()
    expect(call.toolResults[0]!.result).toMatch(/unknown page/)
    expect(JSON.stringify(call)).not.toContain('SECRET')
  })

  it('a key shared by both portfolios loads the BOUND library\'s content, never the other', async () => {
    const { widget } = await setup()
    // An injected portfolio/library arg is ignored.
    await primeAiFake({
      text: 'ok',
      toolCalls: [{ name: 'load_page', input: { ref: `section:${widget.libraryId}:shipping`, portfolio: 'internal-strategy', library: 'Internal Library' } }]
    })
    await sendTurn(widget.id, 'shipping?')
    const call = await chatCall()
    expect(call.toolResults[0]!.result).toContain('We ship worldwide.')
    expect(JSON.stringify(call)).not.toContain('SECRET')
  })

  it('a made-up or malformed ref is unknown', async () => {
    const { widget } = await setup()
    await primeAiFake({
      text: 'ok',
      toolCalls: [
        { name: 'load_page', input: { ref: 'page:00000000-0000-0000-0000-000000000000' } },
        { name: 'load_page', input: { ref: 'section:nope' } },
        { name: 'load_page', input: { ref: '../../etc/passwd' } }
      ]
    })
    await sendTurn(widget.id, 'hi')
    const call = await chatCall()
    expect(call.toolResults).toHaveLength(3)
    for (const r of call.toolResults) expect(r.result).toMatch(/unknown page/)
  })

  it('a widget whose library points at another org\'s portfolio cannot read it (RLS)', async () => {
    const a = await createHelpinatorOrgWith(sql)
    const b = await createHelpinatorOrgWith(sql)
    const foreign = await seedPortfolio(sql, b.org.id, 'Other Org', { faq: 'FOREIGN-CONTENT' })
    // Forged row: org A's library pointing at org B's portfolio.
    const widget = await seedWidget(sql, { orgId: a.org.id, portfolioId: foreign.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'Hi' })
    const err = await sendTurn(widget.id, 'hello').catch(e => e)
    expect(err.statusCode).toBe(503)
    expect(JSON.stringify(await getAiFakeLog())).not.toContain('FOREIGN-CONTENT')
  })

  it('a widget listing another org\'s library cannot see it (RLS)', async () => {
    const a = await createHelpinatorOrgWith(sql)
    const b = await createHelpinatorOrgWith(sql)
    const foreign = await seedPortfolio(sql, b.org.id, 'Other Org', { faq: 'FOREIGN-CONTENT' })
    const foreignLibrary = await seedLibrary(sql, { orgId: b.org.id, portfolioId: foreign.id })
    const widget = await seedWidget(sql, { orgId: a.org.id, libraryIds: [foreignLibrary.id] })
    await primeAiFake({ text: 'Hi' })
    const err = await sendTurn(widget.id, 'hello').catch(e => e)
    expect(err.statusCode).toBe(503)
    expect(JSON.stringify(await getAiFakeLog())).not.toContain('FOREIGN-CONTENT')
  })

  it('a session token from widget A is rejected on widget B', async () => {
    const { org, bound, widget } = await setup()
    const other = await seedWidget(sql, { orgId: org.id, portfolioId: bound.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'Hi' })
    const turn = await sendTurn(widget.id, 'hello')

    const onOther = await $fetch<{ conversationId: string | null, messages: unknown[] }>(
      `/api/v1/helpinator/widgets/${other.id}/conversation`, { headers: widgetHeaders(turn.token) })
    expect(onOther.conversationId).toBeNull()
    expect(onOther.messages).toEqual([])

    // Sending with A's token on B starts a fresh conversation instead.
    await primeAiFake({ text: 'Hi again' })
    const onB = await sendTurn(other.id, 'hello', turn.token)
    expect(onB.reset).toBe(true)
    expect(onB.conversationId).not.toBe(turn.conversationId)
  })

  it('rebinding a widget ends its conversations rather than switching their grounding', async () => {
    const { org } = await createHelpinatorOrgWith(sql)
    const bound = await seedPortfolio(sql, org.id, 'Public Help', { faq: 'Opening hours are 9-5.' })
    const other = await seedPortfolio(sql, org.id, 'Other', { faq: 'OTHER-CONTENT' })
    const otherLibrary = await seedLibrary(sql, { orgId: org.id, portfolioId: other.id })
    const widget = await seedWidget(sql, { orgId: org.id, portfolioId: bound.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'Hi' })
    const first = await sendTurn(widget.id, 'hello')

    await sql`UPDATE helpinator_widgets SET library_ids = ARRAY[${otherLibrary.id}]::uuid[], default_library_id = ${otherLibrary.id} WHERE id = ${widget.id}`
    // Even without the admin route's end-marking, the snapshot mismatch alone
    // ends the conversation.
    const ended = await $fetch<{ conversationId: string | null }>(
      `/api/v1/helpinator/widgets/${widget.id}/conversation`, { headers: widgetHeaders(first.token) })
    expect(ended.conversationId).toBeNull()

    await resetAiFake()
    await primeAiFake({ text: 'Fresh' })
    const next = await sendTurn(widget.id, 'hello again', first.token)
    expect(next.reset).toBe(true)
    // The old conversation's history is not sent to the model.
    const call = await chatCall()
    expect(JSON.stringify(call.messages)).not.toContain('hello"')
    expect(systemText(call)).toContain('OTHER-CONTENT')
  })
})
