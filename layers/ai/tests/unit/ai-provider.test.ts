// Provider routing by stored model id: prefixes pick the provider and are
// stripped on the wire; OpenRouter's own `openai/…` and `anthropic/…` slugs
// stay OpenRouter.
import { describe, it, expect } from 'vitest'
import { modelIdFor, providerOf, wireModelId } from '../../server/utils/ai-provider'

describe('provider routing', () => {
  it('routes prefixed ids to their provider and strips the prefix', () => {
    expect(providerOf('tinfoil/glm-5')).toBe('tinfoil')
    expect(providerOf('openai-api/gpt-5')).toBe('openai')
    expect(providerOf('anthropic-api/claude-opus-5-5')).toBe('anthropic')
    expect(wireModelId('openai-api/gpt-5')).toBe('gpt-5')
    expect(wireModelId('anthropic-api/claude-opus-5-5')).toBe('claude-opus-5-5')
  })

  it('keeps OpenRouter slugs on OpenRouter, unchanged', () => {
    expect(providerOf('openai/gpt-5')).toBe('openrouter')
    expect(providerOf('anthropic/claude-sonnet-4.5')).toBe('openrouter')
    expect(wireModelId('anthropic/claude-sonnet-4.5')).toBe('anthropic/claude-sonnet-4.5')
  })

  it('builds stored ids from wire ids', () => {
    expect(modelIdFor('anthropic', 'claude-haiku-5-5')).toBe('anthropic-api/claude-haiku-5-5')
    expect(modelIdFor('openrouter', 'openai/gpt-5')).toBe('openai/gpt-5')
  })
})
