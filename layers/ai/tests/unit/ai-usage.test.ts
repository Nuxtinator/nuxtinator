// Pure-function coverage for what one AI round trip cost. No Nuxt build needed.
import { describe, it, expect } from 'vitest'
import { usageCost } from '../../server/utils/ai-usage-cost'

const tokenPriced = { promptPrice: 3, completionPrice: 15, requestPrice: null }

describe('usageCost', () => {
  it("uses the provider's own cost when it reports one", () => {
    expect(usageCost({ prompt_tokens: 1000, completion_tokens: 1000, cost: 0.0123 }, tokenPriced)).toBe(0.0123)
    expect(usageCost({ cost: 0 }, undefined)).toBe(0)
  })

  it('applies per-million token prices otherwise', () => {
    expect(usageCost({ prompt_tokens: 1000, completion_tokens: 200 }, tokenPriced)).toBeCloseTo(0.006)
  })

  it('adds a request price to token prices', () => {
    expect(usageCost({ prompt_tokens: 1_000_000 }, { promptPrice: 1, completionPrice: null, requestPrice: 0.5 })).toBeCloseTo(1.5)
  })

  it('charges the request price alone for request-priced models or no tokens', () => {
    expect(usageCost({ prompt_tokens: 500 }, { promptPrice: null, completionPrice: null, requestPrice: 0.01 })).toBe(0.01)
    expect(usageCost(null, { promptPrice: 3, completionPrice: 15, requestPrice: 0.02 })).toBe(0.02)
  })

  it('is null when nothing says what the call cost', () => {
    expect(usageCost({ prompt_tokens: 100 }, undefined)).toBeNull()
    expect(usageCost(null, tokenPriced)).toBeNull()
  })

  it('ignores token counts that are not positive numbers', () => {
    expect(usageCost({ prompt_tokens: '1000', completion_tokens: -5 }, tokenPriced)).toBeNull()
    expect(usageCost({ prompt_tokens: 1_000_000, completion_tokens: Number.NaN }, tokenPriced)).toBeCloseTo(3)
  })
})
