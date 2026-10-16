// Per-widget chat model: a widget's own pick runs ahead of the org's
// `helpinator.chat` choice, only models the org may use can be picked, and a
// pick the org loses falls back (flagged on the admin side) without being
// cleared. Driven on the org's own key so nothing touches the shared host
// AI config the ai suite clears between tests.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupHelpinatorTestData,
  createHelpinatorOrgWith,
  addHelpinatorMember,
  seedPortfolio,
  seedWidget,
  sendTurn,
  primeAiFake,
  resetAiFake,
  getAiFakeLog,
  widgetHeaders,
  SITE_ORIGIN
} from '../helpers'

const ALPHA = 'test/alpha'
const BETA = 'test/beta'
const GAMMA = 'test/gamma'
const WHISPER = 'test/whisper'

interface AdminWidget {
  id: string
  chat_model: string | null
  chat_model_unavailable: boolean
}

describe('per-widget chat model', () => {
  const sql = getHostAdminDb()

  beforeEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })
  afterEach(async () => {
    await cleanupHelpinatorTestData(sql)
    await resetAiFake()
  })

  async function orgModels(opts: object, enabled: string[]) {
    await $fetch('/api/ai/org/config', {
      method: 'PUT',
      body: { enabled_models: enabled, feature_models: { 'helpinator.chat': ALPHA } },
      ...opts
    })
  }

  async function setup() {
    const ctx = await createHelpinatorOrgWith(sql)
    await $fetch('/api/ai/org/key', { method: 'PUT', body: { provider: 'openrouter', key: 'sk-or-test-abcd1234' }, ...ctx.opts })
    await orgModels(ctx.opts, [ALPHA, BETA, WHISPER])
    const p = await seedPortfolio(sql, ctx.org.id, 'Public Help', { faq: 'Opening hours are 9-5.' })
    const widget = await seedWidget(sql, { orgId: ctx.org.id, portfolioId: p.id, sectionKey: 'faq' })
    return { ...ctx, widget }
  }

  async function putWidget(opts: object, widget: { id: string, libraryId: string }, chatModel: string | null): Promise<AdminWidget> {
    return await $fetch<AdminWidget>(`/api/helpinator/widgets/${widget.id}`, {
      method: 'PUT',
      body: { name: 'Test widget', library_ids: [widget.libraryId], default_library_id: widget.libraryId, default_section_key: 'faq', allowed_origins: [SITE_ORIGIN], chat_model: chatModel },
      ...opts
    })
  }

  async function lastCompleteModel(): Promise<string | undefined> {
    return (await getAiFakeLog()).filter(c => c.kind === 'complete').at(-1)?.model
  }

  it('a widget with no model runs on the org\'s helpinator.chat choice', async () => {
    const { widget } = await setup()
    await primeAiFake({ text: 'Hi.' })
    await sendTurn(widget.id, 'Hello')
    expect(await lastCompleteModel()).toBe(ALPHA)
  })

  it('a widget\'s own model runs instead, and is recorded on the reply', async () => {
    const { opts, widget } = await setup()
    const saved = await putWidget(opts, widget, BETA)
    expect(saved).toMatchObject({ chat_model: BETA, chat_model_unavailable: false })

    await primeAiFake({ text: 'Hi.' })
    const turn = await sendTurn(widget.id, 'Hello')
    expect(await lastCompleteModel()).toBe(BETA)
    const [row] = await sql`SELECT model FROM helpinator_messages WHERE id = ${turn.assistantMessage.id}`
    expect(row!.model).toBe(BETA)

    // Clearing it goes back to the org's choice.
    expect((await putWidget(opts, widget, null)).chat_model).toBeNull()
    await primeAiFake({ text: 'Hi.' })
    await sendTurn(widget.id, 'Hello again')
    expect(await lastCompleteModel()).toBe(ALPHA)
  })

  it('refuses a model the org may not use, and a non-chat model', async () => {
    const { opts, widget } = await setup()
    await expect(putWidget(opts, widget, GAMMA)).rejects.toMatchObject({ statusCode: 400 })
    await expect(putWidget(opts, widget, WHISPER)).rejects.toMatchObject({ statusCode: 400 })
    const [row] = await sql`SELECT chat_model FROM helpinator_widgets WHERE id = ${widget.id}`
    expect(row!.chat_model).toBeNull()
  })

  it('a model the org loses falls back, is flagged, and survives unrelated saves', async () => {
    const { opts, widget } = await setup()
    await putWidget(opts, widget, BETA)
    await orgModels(opts, [ALPHA])

    await primeAiFake({ text: 'Hi.' })
    await sendTurn(widget.id, 'Hello')
    expect(await lastCompleteModel()).toBe(ALPHA)

    const one = await $fetch<AdminWidget>(`/api/helpinator/widgets/${widget.id}`, opts)
    expect(one).toMatchObject({ chat_model: BETA, chat_model_unavailable: true })
    const list = await $fetch<AdminWidget[]>('/api/helpinator/widgets', opts)
    expect(list.find(w => w.id === widget.id)).toMatchObject({ chat_model_unavailable: true })

    // Saving with the same (lost) pick is allowed and keeps it.
    expect(await putWidget(opts, widget, BETA)).toMatchObject({ chat_model: BETA, chat_model_unavailable: true })

    // Enabling it again clears the flag and the widget is back on it.
    await orgModels(opts, [ALPHA, BETA])
    expect((await $fetch<AdminWidget>(`/api/helpinator/widgets/${widget.id}`, opts)).chat_model_unavailable).toBe(false)
    await primeAiFake({ text: 'Hi.' })
    await sendTurn(widget.id, 'Hello again')
    expect(await lastCompleteModel()).toBe(BETA)
  })

  it('the picker lists the org\'s chat models and the default, for managers only', async () => {
    const { org, opts } = await setup()
    const res = await $fetch<{ models: { id: string }[], defaultModel: string }>('/api/helpinator/models', opts)
    expect(res.models.map(m => m.id).sort()).toEqual([ALPHA, BETA])
    expect(res.defaultModel).toBe(ALPHA)

    const member = await addHelpinatorMember(sql, org)
    await expect($fetch('/api/helpinator/models', member.opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('the public config never names the model', async () => {
    const { opts, widget } = await setup()
    await putWidget(opts, widget, BETA)
    const cfg = await $fetch(`/api/v1/helpinator/widgets/${widget.id}/config`, { headers: widgetHeaders() })
    expect(JSON.stringify(cfg)).not.toContain(BETA)
    expect(cfg).toMatchObject({ aiAvailable: true })
  })
})
