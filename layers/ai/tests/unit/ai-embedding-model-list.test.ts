import { describe, it, expect } from 'vitest'
import { parseOpenRouterEmbeddingModels } from '../../server/utils/ai-embedding-model-list'

describe('parseOpenRouterEmbeddingModels', () => {
  it('maps id, name, price per million and context length', () => {
    const out = parseOpenRouterEmbeddingModels({
      data: [
        { id: 'openai/text-embedding-3-small', name: 'OpenAI: Embedding 3 Small', pricing: { prompt: '0.00000002' }, context_length: 8191 }
      ]
    })
    expect(out).toEqual([
      { id: 'openai/text-embedding-3-small', name: 'OpenAI: Embedding 3 Small', promptPrice: 0.02, contextLength: 8191 }
    ])
  })

  it('drops malformed entries, dedupes and sorts by name', () => {
    const out = parseOpenRouterEmbeddingModels({
      data: [
        { id: 'b/model', name: 'Zed' },
        { id: 'a/model', name: 'Alpha', pricing: { prompt: 'nope' } },
        { id: 'a/model', name: 'Alpha again' },
        { name: 'no id' },
        null
      ]
    })
    expect(out.map(m => m.id)).toEqual(['a/model', 'b/model'])
    expect(out[0]).toMatchObject({ promptPrice: null, contextLength: null })
  })

  it('returns [] for a payload without data', () => {
    expect(parseOpenRouterEmbeddingModels(null)).toEqual([])
    expect(parseOpenRouterEmbeddingModels({})).toEqual([])
  })
})
