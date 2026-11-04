import { describe, it, expect } from 'vitest'
import { AI_EMBED_DIMENSIONS, toPgVector, cosineSimilarity } from '../../../core/ai-fallback/vectors'

describe('vectors', () => {
  it('serialises a full-width vector to the pgvector literal', () => {
    const v = new Array(AI_EMBED_DIMENSIONS).fill(0)
    v[0] = 0.5
    v[1] = Number.NaN
    const s = toPgVector(v)
    expect(s.startsWith('[0.5,0,0')).toBe(true)
    expect(s.endsWith(']')).toBe(true)
  })

  it('refuses the wrong width', () => {
    expect(() => toPgVector([1, 2, 3])).toThrow(/1536/)
  })

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})
