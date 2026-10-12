// OpenAI and Anthropic catalog parsing: OpenAI ids kept only when OpenRouter
// describes them, Anthropic models built from their own capabilities with
// OpenRouter's prices when the slug matches.
import { describe, it, expect } from 'vitest'
import { anthropicOpenRouterId, openAiModelsFrom, parseAnthropicModels, parseProviderModelIds } from '../../server/utils/direct-models'
import type { AiProviderModelInfo } from '../../types/ai-ext'

function orModel(overrides: Partial<AiProviderModelInfo> & Pick<AiProviderModelInfo, 'id' | 'name'>): AiProviderModelInfo {
  return {
    promptPrice: 1,
    completionPrice: 4,
    contextLength: 200_000,
    supportsTemperature: true,
    supportsCaching: true,
    provider: 'openrouter',
    kind: 'chat',
    supportsImages: true,
    requestPrice: null,
    reasoning: null,
    ...overrides
  }
}

describe('openAiModelsFrom', () => {
  it('keeps ids OpenRouter lists as tool-capable and borrows their info', () => {
    const openrouter = [
      orModel({ id: 'openai/gpt-5', name: 'OpenAI: GPT-5', reasoning: { enable: { reasoning: { effort: '$EFFORT' } }, disable: null, effortMap: {} } })
    ]
    const ids = parseProviderModelIds({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }] })
    const out = openAiModelsFrom(ids, openrouter)
    expect(out.map(m => m.id)).toEqual(['openai-api/gpt-5'])
    expect(out[0]).toMatchObject({ provider: 'openai', name: 'OpenAI: GPT-5', promptPrice: 1 })
    expect(out[0]!.reasoning?.enable).toEqual({ reasoning_effort: '$EFFORT' })
  })
})

describe('parseAnthropicModels', () => {
  it('maps Anthropic ids onto OpenRouter slugs', () => {
    expect(anthropicOpenRouterId('claude-sonnet-4-5-20250929')).toBe('anthropic/claude-sonnet-4.5')
    expect(anthropicOpenRouterId('claude-opus-5-5')).toBe('anthropic/claude-opus-5.5')
    expect(anthropicOpenRouterId('claude-opus-4-20250514')).toBe('anthropic/claude-opus-4')
  })

  it('reads context and capabilities from Anthropic and prices from OpenRouter', () => {
    const out = parseAnthropicModels({
      data: [
        {
          id: 'claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          max_input_tokens: 1_000_000,
          capabilities: { image_input: { supported: true }, effort: { supported: true } }
        },
        { id: 'claude-mystery-1', display_name: 'Claude Mystery', capabilities: { image_input: { supported: false } } }
      ]
    }, [orModel({ id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', promptPrice: 4, completionPrice: 20, supportsTemperature: false })])

    const opus = out.find(m => m.id === 'anthropic-api/claude-opus-5-5')!
    expect(opus).toMatchObject({
      name: 'Claude Opus 5.5',
      provider: 'anthropic',
      contextLength: 1_000_000,
      promptPrice: 4,
      completionPrice: 20,
      supportsImages: true,
      supportsCaching: true,
      supportsTemperature: false
    })
    expect(opus.reasoning?.enable).toEqual({ output_config: { effort: '$EFFORT' } })

    const mystery = out.find(m => m.id === 'anthropic-api/claude-mystery-1')!
    expect(mystery).toMatchObject({ promptPrice: null, supportsImages: false, reasoning: null })
  })
})
