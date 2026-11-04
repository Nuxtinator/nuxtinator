// The streamed form of the messages endpoint: with `Accept: text/event-stream`
// a turn arrives as server-sent events — progress as sections load, reply text
// as it is written, a reset for text the model wrote before a tool call, and
// the persisted turn last — and the JSON form is unchanged.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextOrgWith,
  createTestPortfolio,
  seedTestSection,
  withOrgHeader,
  primeAiFake,
  resetAiFake,
  getAiFakeLog,
  sectionUpdateBlock
} from '../helpers'

interface Frame {
  event: string
  data: any
}

function parseFrames(raw: string): Frame[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(l => l && !l.startsWith(':')))
    .filter(lines => lines.length > 0)
    .map((lines) => {
      const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() ?? 'message'
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
      return { event, data: data ? JSON.parse(data) : null }
    })
}

describe('assistant streamed turns', () => {
  const sql = getHostAdminDb()
  beforeEach(async () => { await resetAiFake() })
  afterEach(async () => { await cleanupContextTestData(sql) })

  it('streams progress, discarded preface, reply text, then the persisted turn', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Acme Portfolio', created_by: user.id })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'identity', content: 'IDENTITY BODY' })
    await seedTestSection(sql, { portfolio_id: p.id, section_key: 'team', content: 'TEAM BODY' })
    const reply = `Here is the update:\n\n${sectionUpdateBlock({ section_key: 'team', section_title: 'Team', content: 'TEAM v2' })}`
    await primeAiFake({
      discardedText: 'Let me read the team section.',
      toolCalls: [{ name: 'load_section', input: { section_key: 'team' } }],
      text: reply
    })

    const { conversation } = await $fetch<{ conversation: { id: string } }>('/api/context/assistant/conversations', {
      method: 'POST',
      body: { portfolio: p.slug, section: 'identity' },
      ...opts
    })
    const raw = await $fetch<string>(`/api/context/assistant/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: { message: 'Update the team section' },
      responseType: 'text',
      headers: { ...opts.headers, accept: 'text/event-stream' }
    })

    const frames = parseFrames(raw)
    const names = frames.map(f => f.event)
    const status = names.indexOf('status')
    expect(status).toBeGreaterThan(0)
    expect(frames[status]!.data).toEqual({ text: 'Reading Team…' })
    expect(names[status + 1]).toBe('reset')
    expect(names.at(-1)).toBe('done')
    expect(frames.slice(0, status).map(f => f.event).every(e => e === 'delta')).toBe(true)
    expect(frames.slice(0, status).map(f => f.data.text).join('')).toBe('Let me read the team section.')
    expect(frames.slice(status + 2, -1).map(f => f.event).every(e => e === 'delta')).toBe(true)
    expect(frames.slice(status + 2, -1).map(f => f.data.text).join('')).toBe(reply)

    const done = frames.at(-1)!.data
    expect(done.user_message.content).toBe('Update the team section')
    expect(done.assistant_message.content).toBe('Here is the update:')
    expect(done.assistant_message.proposals).toHaveLength(1)
    expect(done.assistant_message.proposals[0].proposed_content).toBe('TEAM v2')
    expect(done.assistant_message.context_loaded).toEqual(['Identity', 'Team'])
    expect(done.can_apply).toBe(true)

    const detail = await $fetch<{ messages: Array<{ id: string, role: string }> }>(`/api/context/assistant/conversations/${conversation.id}`, opts)
    expect(detail.messages.map(m => m.id)).toEqual([done.user_message.id, done.assistant_message.id])
    expect((await getAiFakeLog()).at(-1)!.streamed).toBe(true)
  })

  it('answers JSON without the header and does not stream the fake', async () => {
    const { org, auth, user } = await createContextOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const p = await createTestPortfolio(sql, { org_id: org.id, name: 'Acme Portfolio', created_by: user.id })
    await primeAiFake({ text: 'Plain answer.' })
    const { conversation } = await $fetch<{ conversation: { id: string } }>('/api/context/assistant/conversations', {
      method: 'POST',
      body: { portfolio: p.slug },
      ...opts
    })
    const turn = await $fetch<{ assistant_message: { content: string } }>(`/api/context/assistant/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: { message: 'Hello' },
      ...opts
    })
    expect(turn.assistant_message.content).toBe('Plain answer.')
    expect((await getAiFakeLog()).at(-1)!.streamed).toBe(false)
  })
})
