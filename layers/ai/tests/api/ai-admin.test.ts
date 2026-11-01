// Host AI config endpoints: operator-admin gating, the enabled-set / default /
// per-feature read, write validation against the enabled set, and the
// host-level sharing across orgs. Runs against the booted host with the VITEST
// stub (fixed model list, no key needed).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { getHostAdminDb, createAiOrg, cleanupAiTestData, clearAiHostConfig, AI_TEST_MODEL_IDS, AI_TEST_TRANSCRIPTION_MODEL_ID, AI_TEST_DECISION_MODEL_ID } from '../helpers'

interface AiEnabled {
  id: string
  name: string
  available: boolean
  supportsCaching: boolean
}
interface AiConfig {
  providers: { provider: string, envVar: string, keySource: 'env' | 'stored' | 'none', storedKey: { status: string, last4: string } }[]
  modelListAvailable: boolean
  catalog: { id: string, provider: string }[]
  enabled: AiEnabled[]
  defaultModel: string
  features: { key: string, label: string, kind: string, model: string, effectiveModel: string }[]
  embeddingAvailable: boolean
  embeddingModelListAvailable: boolean
  embeddingModel: string
  staleScopes: { orgId: string | null, model: string, stored: string[] }[]
}

const sql = getHostAdminDb()
const [ALPHA, BETA, GAMMA] = AI_TEST_MODEL_IDS
const WHISPER = AI_TEST_TRANSCRIPTION_MODEL_ID
const DECIDER = AI_TEST_DECISION_MODEL_ID

async function getConfig(opts: object): Promise<AiConfig> {
  return $fetch<AiConfig>('/api/ai/admin/config', { ...opts })
}
async function putConfig(opts: object, body: Record<string, unknown>): Promise<unknown> {
  return $fetch('/api/ai/admin/config', { method: 'PUT', body, ...opts })
}

describe('ai admin config', () => {
  beforeAll(async () => {
    await cleanupAiTestData(sql)
  })
  beforeEach(async () => {
    await clearAiHostConfig(sql)
  })
  afterAll(async () => {
    await cleanupAiTestData(sql)
  })

  it('rejects a non-operator-admin', async () => {
    const { opts } = await createAiOrg(sql, { admin: false })
    await expect(getConfig(opts)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('answers without an active org (the /admin/ai page sends none)', async () => {
    const { auth } = await createAiOrg(sql)
    const config = await getConfig(auth)
    expect(config.modelListAvailable).toBe(true)
  })

  it('starts with nothing enabled and no default', async () => {
    const { opts } = await createAiOrg(sql)
    const config = await getConfig(opts)
    expect(config.enabled).toEqual([])
    expect(config.defaultModel).toBe('')
    for (const f of config.features) expect(f.effectiveModel).toBe('')
  })

  it('serves the live model list to any authenticated user', async () => {
    const { opts } = await createAiOrg(sql, { admin: false })
    const { models } = await $fetch<{ models: { id: string, name: string }[] }>('/api/ai/models', { ...opts })
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(AI_TEST_MODEL_IDS))
  })

  it('enables models and reflects them with live info', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA, BETA] })
    const config = await getConfig(opts)
    expect(config.enabled.map(m => m.id)).toEqual([ALPHA, BETA])
    const alpha = config.enabled.find(m => m.id === ALPHA)!
    expect(alpha.name).toBe('Test Alpha')
    expect(alpha.available).toBe(true)
    expect(alpha.supportsCaching).toBe(true)
  })

  it('sanitizes the enabled set on write (dedupes, drops non-strings and unlisted ids)', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA, ALPHA, 42, 'not/a-real-model'] })
    const config = await getConfig(opts)
    expect(config.enabled.map(m => m.id)).toEqual([ALPHA])
  })

  it('requires the default model to be enabled', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA] })
    await expect(putConfig(opts, { default_model: BETA })).rejects.toMatchObject({ statusCode: 400 })
    await putConfig(opts, { default_model: ALPHA })
    expect((await getConfig(opts)).defaultModel).toBe(ALPHA)
    // '' clears it.
    await putConfig(opts, { default_model: '' })
    expect((await getConfig(opts)).defaultModel).toBe('')
  })

  it('requires feature models to be enabled and resolves features through the default', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA, BETA], default_model: ALPHA })
    const before = await getConfig(opts)
    // Every registered feature falls back to the host default.
    for (const f of before.features) {
      expect(f.model).toBe('')
      expect(f.effectiveModel).toBe(ALPHA)
    }
    if (before.features.length === 0) return

    const feature = before.features[0]!.key
    await expect(putConfig(opts, { feature_models: { [feature]: GAMMA } })).rejects.toMatchObject({ statusCode: 400 })
    await putConfig(opts, { feature_models: { [feature]: BETA } })
    const after = await getConfig(opts)
    const chosen = after.features.find(f => f.key === feature)!
    expect(chosen.model).toBe(BETA)
    expect(chosen.effectiveModel).toBe(BETA)
  })

  it('lists models with their provider and kind', async () => {
    const { opts } = await createAiOrg(sql)
    const { models } = await $fetch<{ models: { id: string, provider: string, kind: string }[] }>('/api/ai/models', { ...opts })
    expect(models.find(m => m.id === ALPHA)).toMatchObject({ provider: 'openrouter', kind: 'chat' })
    expect(models.find(m => m.id === WHISPER)).toMatchObject({ kind: 'transcription' })
    expect(models.find(m => m.id === DECIDER)).toMatchObject({ kind: 'decision' })
  })

  it('refuses a decision model as the default or for a chat feature', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA, DECIDER] })
    await expect(putConfig(opts, { default_model: DECIDER })).rejects.toMatchObject({ statusCode: 400 })

    const { features } = await getConfig(opts)
    const chat = features.find(f => f.kind === 'chat')
    if (!chat) return
    await expect(putConfig(opts, { feature_models: { [chat.key]: DECIDER } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses a transcription model as the default or for a chat feature', async () => {
    const { opts } = await createAiOrg(sql)
    await putConfig(opts, { enabled_models: [ALPHA, WHISPER] })
    await expect(putConfig(opts, { default_model: WHISPER })).rejects.toMatchObject({ statusCode: 400 })

    const { features } = await getConfig(opts)
    const chat = features.find(f => f.kind === 'chat')
    if (!chat) return
    await expect(putConfig(opts, { feature_models: { [chat.key]: WHISPER } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lists every provider with where its host key comes from', async () => {
    const { opts } = await createAiOrg(sql)
    const config = await getConfig(opts)
    expect(config.providers.map(p => p.provider)).toEqual(['openrouter', 'tinfoil', 'openai', 'anthropic'])
    expect(config.providers.find(p => p.provider === 'anthropic')!.envVar).toBe('ANTHROPIC_API_KEY')
    expect(config.catalog.map(m => m.id)).toEqual(expect.arrayContaining([ALPHA, 'anthropic-api/test-sigma']))
  })

  it('stores a host key only for providers without an env key, masked, and removes it', async () => {
    const { auth } = await createAiOrg(sql)
    const member = await createAiOrg(sql, { admin: false })
    await expect($fetch('/api/ai/admin/key', { method: 'PUT', body: { provider: 'openai', key: 'sk-x' }, ...member.opts }))
      .rejects.toMatchObject({ statusCode: 403 })

    for (const p of (await getConfig(auth)).providers) {
      const put = $fetch<{ last4: string }>('/api/ai/admin/key', { method: 'PUT', body: { provider: p.provider, key: 'sk-test-host-9876' }, ...auth })
      if (p.keySource === 'env') {
        await expect(put).rejects.toMatchObject({ statusCode: 409 })
        continue
      }
      expect((await put).last4).toBe('9876')
      let state = (await getConfig(auth)).providers.find(x => x.provider === p.provider)!
      expect(state).toMatchObject({ keySource: 'stored', storedKey: { status: 'ok', last4: '9876' } })

      await $fetch('/api/ai/admin/key', { method: 'DELETE', query: { provider: p.provider }, ...auth })
      state = (await getConfig(auth)).providers.find(x => x.provider === p.provider)!
      expect(state.keySource).toBe('none')
    }

    await expect($fetch('/api/ai/admin/key', { method: 'PUT', body: { provider: 'openai', key: 'invalid' }, ...auth }))
      .rejects.toMatchObject({ statusCode: expect.any(Number) })
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM core_host_settings WHERE namespace = 'ai' AND value::text LIKE '%sk-test-host%'`
    expect(row!.n).toBe(0)
  })

  it('shares one config across orgs (host-level)', async () => {
    const a = await createAiOrg(sql)
    const b = await createAiOrg(sql)
    await putConfig(a.opts, { enabled_models: [BETA], default_model: BETA })
    const configB = await getConfig(b.opts)
    expect(configB.enabled.map(m => m.id)).toEqual([BETA])
    expect(configB.defaultModel).toBe(BETA)
  })
})

describe('ai status', () => {
  beforeEach(async () => {
    await clearAiHostConfig(sql)
  })

  it('reports no usable model until the host enables one and picks a default', async () => {
    const { opts } = await createAiOrg(sql)
    const before = await $fetch<{ configured: boolean, hasEnabledModel: boolean, featureAvailable: boolean }>(
      '/api/ai/status',
      { ...opts }
    )
    expect(before.configured).toBe(true)
    expect(before.hasEnabledModel).toBe(false)
    expect(before.featureAvailable).toBe(false)

    await putConfig(opts, { enabled_models: [ALPHA], default_model: ALPHA })
    const after = await $fetch<{ configured: boolean, hasEnabledModel: boolean, featureAvailable: boolean }>(
      '/api/ai/status',
      { ...opts }
    )
    expect(after.hasEnabledModel).toBe(true)
    expect(after.featureAvailable).toBe(true)
  })

  it('stores an embedding model from the live list, refuses an unknown one, and hides embedding features from the chat pickers', async () => {
    const { auth, opts } = await createAiOrg(sql)
    const before = await getConfig(auth)
    // The dev host loads context + helpinator, both of which register an
    // embedding feature; those never appear as chat features.
    expect(before.embeddingAvailable).toBe(true)
    expect(before.embeddingModelListAvailable).toBe(true)
    expect(before.embeddingModel).toBe('')
    expect(before.features.map(f => f.key)).not.toContain('context.embeddings')
    expect(before.features.map(f => f.key)).not.toContain('helpinator.embeddings')

    const list = await $fetch<{ models: { id: string }[] }>('/api/ai/embedding-models', { ...opts })
    expect(list.models.map(m => m.id).sort()).toEqual(['test/embed-large', 'test/embed-small'])

    await expect(putConfig(auth, { embedding_model: 'nope/model' })).rejects.toMatchObject({ statusCode: 400 })
    await putConfig(auth, { embedding_model: 'test/embed-large' })
    expect((await getConfig(auth)).embeddingModel).toBe('test/embed-large')
    await putConfig(auth, { embedding_model: '' })
    expect((await getConfig(auth)).embeddingModel).toBe('')
  })

  it('reindex endpoints are operator-only and report a run', async () => {
    const { opts } = await createAiOrg(sql, { admin: false })
    await expect($fetch('/api/ai/admin/reindex', { method: 'POST', body: {}, ...opts })).rejects.toMatchObject({ statusCode: 403 })
    const { auth } = await createAiOrg(sql)
    const res = await $fetch<{ started: boolean, reason: string | null, status: { running: boolean } }>('/api/ai/admin/reindex', { method: 'POST', body: {}, ...auth })
    // Nothing is stale on a fresh host, so nothing starts.
    expect(res.started).toBe(false)
    expect(res.reason).toBe('nothing-stale')
    const status = await $fetch<{ running: boolean, scopes: unknown[] }>('/api/ai/admin/reindex-status', { ...auth })
    expect(typeof status.running).toBe('boolean')
  })
})
