// Pure-function coverage for the Tinfoil catalog parser and the provider /
// reasoning helpers. No Nuxt build needed.
import { describe, it, expect } from 'vitest'
import { parseTinfoilModels } from '../../server/utils/tinfoil-models'
import { providerOf, reasoningParams, wireModelId } from '../../server/utils/ai-provider'

function chat(overrides: Record<string, unknown>) {
  return {
    modelName: 'glm-5-3-flash',
    name: 'GLM-5.3 Flash',
    type: 'chat',
    toolCalling: true,
    multimodal: true,
    endpoints: ['/v1/chat/completions', '/v1/responses'],
    contextWindowTokens: 1048576,
    pricing: { inputTokenPricePer1M: 0.4, outputTokenPricePer1M: 1.25, requestPrice: 0 },
    chatConfig: {
      reasoningConfig: {
        effortMap: { high: 'max', low: 'low', medium: 'high' },
        params: {
          '/v1/chat/completions': {
            enable: { chat_template_kwargs: { clear_thinking: false, reasoning_effort: '$EFFORT' } }
          }
        }
      }
    },
    ...overrides
  }
}

describe('parseTinfoilModels', () => {
  it('keeps tool-capable chat models and file-upload transcription models', () => {
    const out = parseTinfoilModels([
      chat({}),
      chat({ modelName: 'no-tools', toolCalling: false }),
      { modelName: 'whisper-large-v3-turbo', name: 'Whisper', type: 'audio', endpoints: ['/v1/audio/transcriptions'], pricing: { requestPrice: 0.01 } },
      { modelName: 'voxtral-realtime', name: 'Realtime', type: 'audio', endpoints: ['/v1/realtime'] },
      { modelName: 'nomic-embed-text', type: 'embedding', endpoints: ['/v1/embeddings'] }
    ])
    expect(out.map(m => [m.id, m.kind])).toEqual([
      ['tinfoil/glm-5-3-flash', 'chat'],
      ['tinfoil/whisper-large-v3-turbo', 'transcription']
    ])
  })

  it('reads prices, context, image support and request pricing', () => {
    const [glm, whisper] = parseTinfoilModels([
      chat({}),
      { modelName: 'whisper-large-v3-turbo', name: 'Whisper', type: 'audio', endpoints: ['/v1/audio/transcriptions'], pricing: { requestPrice: 0.01 } }
    ])
    expect(glm).toMatchObject({ provider: 'tinfoil', promptPrice: 0.4, completionPrice: 1.25, requestPrice: null, contextLength: 1048576, supportsImages: true })
    expect(whisper).toMatchObject({ requestPrice: 0.01, supportsImages: false, reasoning: null })
  })

  it('reads the reasoning spec from chatConfig', () => {
    const [glm] = parseTinfoilModels([chat({})])
    expect(glm!.reasoning).toEqual({
      enable: { chat_template_kwargs: { clear_thinking: false, reasoning_effort: '$EFFORT' } },
      disable: null,
      effortMap: { high: 'max', low: 'low', medium: 'high' }
    })
  })

  it('keeps decision models that serve /v1/decisions', () => {
    const out = parseTinfoilModels([
      { modelName: 'decision-small', name: 'Decision Small', type: 'decision', toolCalling: false, endpoints: ['/v1/decisions'], contextWindowTokens: 32768, pricing: { inputTokenPricePer1M: 0.02, outputTokenPricePer1M: 0, requestPrice: 0 } },
      { modelName: 'decision-other', name: 'Other', type: 'decision', endpoints: ['/v1/other'] }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'tinfoil/decision-small', kind: 'decision', promptPrice: 0.02, requestPrice: null, contextLength: 32768, supportsTemperature: false, supportsImages: false, reasoning: null })
  })

  it('returns an empty list for a non-array payload', () => {
    expect(parseTinfoilModels(null)).toEqual([])
    expect(parseTinfoilModels({ models: [] })).toEqual([])
  })
})

describe('provider helpers', () => {
  it('routes prefixed ids to Tinfoil and strips the prefix on the wire', () => {
    expect(providerOf('tinfoil/gemma4-31b')).toBe('tinfoil')
    expect(wireModelId('tinfoil/gemma4-31b')).toBe('gemma4-31b')
    expect(providerOf('anthropic/claude-sonnet')).toBe('openrouter')
    expect(wireModelId('anthropic/claude-sonnet')).toBe('anthropic/claude-sonnet')
  })
})

describe('reasoningParams', () => {
  const spec = {
    enable: { chat_template_kwargs: { reasoning_effort: '$EFFORT', thinking: true } },
    disable: { chat_template_kwargs: { thinking: false } },
    effortMap: { high: 'xhigh' }
  }

  it('substitutes the mapped effort, falling back to the level itself', () => {
    expect(reasoningParams(spec, 'high')).toEqual({ chat_template_kwargs: { reasoning_effort: 'xhigh', thinking: true } })
    expect(reasoningParams(spec, 'low')).toEqual({ chat_template_kwargs: { reasoning_effort: 'low', thinking: true } })
  })

  it('uses the disable fragment for off, and nothing when the model has none', () => {
    expect(reasoningParams(spec, 'off')).toEqual({ chat_template_kwargs: { thinking: false } })
    expect(reasoningParams({ ...spec, disable: null }, 'off')).toEqual({})
  })

  it('sends nothing without a spec or a level', () => {
    expect(reasoningParams(null, 'high')).toEqual({})
    expect(reasoningParams(spec, undefined)).toEqual({})
  })
})
