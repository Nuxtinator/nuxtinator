// Context portfolios limited to teams: the widget form's picker and new
// bindings follow the caller's Context teams; the public bot still reads them.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
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
  getAiFakeLog,
  systemText
} from '../helpers'

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err: unknown) {
    const e = err as { statusCode?: number, response?: { status?: number } }
    return e.response?.status ?? e.statusCode ?? 0
  }
}

describe('helpinator and team-limited portfolios', () => {
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
    const { org, opts: adminOpts } = await createHelpinatorOrgWith(sql)
    const teamAdmin = await addHelpinatorMember(sql, org, ['admin'])
    await $fetch(`/api/o/${org.slug}/groups/mode`, { method: 'PUT', body: { mode: 'teams' }, ...adminOpts })
    const group = await $fetch<{ id: string }>(`/api/o/${org.slug}/groups`, { method: 'POST', body: { name: `test-helpinator-dev-${randomUUID().slice(0, 6)}` }, ...adminOpts })
    await $fetch(`/api/o/${org.slug}/groups/${group.id}/members/${teamAdmin.user.id}`, { method: 'PUT', ...adminOpts })

    const hidden = await seedPortfolio(sql, org.id, 'Dev Only', { faq: 'Opening hours are 9-5.' })
    await sql`UPDATE context_portfolios SET visibility = 'teams' WHERE id = ${hidden.id}`
    await sql`INSERT INTO context_portfolio_teams (container_id, group_id, org_id) VALUES (${hidden.id}, ${group.id}, ${org.id})`
    const open = await seedPortfolio(sql, org.id, 'Everyone', { faq: 'Hello.' })
    return { org, adminOpts, teamOpts: teamAdmin.opts, hidden, open }
  }

  it('lists only the portfolios the caller\'s teams can see in the picker', async () => {
    const s = await setup()
    const offTeam = await $fetch<{ id: string }[]>('/api/helpinator/portfolios', s.adminOpts)
    expect(offTeam.map(p => p.id)).toEqual([s.open.id])
    const onTeam = await $fetch<{ id: string }[]>('/api/helpinator/portfolios', s.teamOpts)
    expect(onTeam.map(p => p.id).sort()).toEqual([s.hidden.id, s.open.id].sort())
    const all = await $fetch<{ id: string }[]>('/api/helpinator/portfolios', { headers: { ...s.adminOpts.headers, 'x-show-all-teams': '1' } })
    expect(all.map(p => p.id).sort()).toEqual([s.hidden.id, s.open.id].sort())
  })

  it('refuses to bind a portfolio the caller can\'t see', async () => {
    const s = await setup()
    expect(await status($fetch('/api/helpinator/libraries', {
      method: 'POST', body: { name: 'Leak', kind: 'portfolio', portfolio_id: s.hidden.id }, ...s.adminOpts
    }))).toBe(404)

    const openLib = await $fetch<{ id: string }>('/api/helpinator/libraries', {
      method: 'POST', body: { name: 'Open', kind: 'portfolio', portfolio_id: s.open.id }, ...s.adminOpts
    })
    expect(await status($fetch(`/api/helpinator/libraries/${openLib.id}`, {
      method: 'PUT', body: { name: 'Open', kind: 'portfolio', portfolio_id: s.hidden.id }, ...s.adminOpts
    }))).toBe(404)

    const hiddenLib = await seedLibrary(sql, { orgId: s.org.id, portfolioId: s.hidden.id })
    const widget = { name: 'W', library_ids: [hiddenLib.id], default_library_id: hiddenLib.id, allowed_origins: ['https://example.org'] }
    expect(await status($fetch('/api/helpinator/widgets', { method: 'POST', body: widget, ...s.adminOpts }))).toBe(404)
    expect(await status($fetch('/api/helpinator/widgets', { method: 'POST', body: widget, ...s.teamOpts }))).toBe(200)

    const team = await $fetch<{ id: string }>('/api/helpinator/libraries', {
      method: 'POST', body: { name: 'Dev', kind: 'portfolio', portfolio_id: s.hidden.id }, ...s.teamOpts
    })
    expect(await status($fetch(`/api/helpinator/libraries/${team.id}`, {
      method: 'PUT', body: { name: 'Dev renamed', kind: 'portfolio', portfolio_id: s.hidden.id }, ...s.adminOpts
    }))).toBe(200)
  })

  it('lets the public bot answer from a team-limited portfolio', async () => {
    const s = await setup()
    const widget = await seedWidget(sql, { orgId: s.org.id, portfolioId: s.hidden.id, sectionKey: 'faq' })
    await primeAiFake({ text: 'We open at 9.' })
    const turn = await sendTurn(widget.id, 'opening hours')
    expect(turn.assistantMessage.content).toBe('We open at 9.')
    const call = (await getAiFakeLog()).find(c => c.kind === 'complete')!
    expect(systemText(call)).toContain('Opening hours are 9-5.')
  })
})
