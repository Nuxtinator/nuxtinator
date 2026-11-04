// Provider retry policy: transient (502) failures retry with growing backoff
// and succeed when the provider recovers; other failures surface at once; the
// attempt cap rethrows the last transient error.
import { describe, it, expect } from 'vitest'
import { withAiRetries, isRetryableAiError } from '../../server/utils/ai-retry'

function transient(message = 'busy') {
  return Object.assign(new Error(message), { statusCode: 502 })
}

describe('withAiRetries', () => {
  it('retries a transient failure with linear backoff and returns the recovery', async () => {
    const delays: number[] = []
    let calls = 0
    const result = await withAiRetries(async () => {
      calls++
      if (calls < 3) throw transient()
      return 'ok'
    }, { baseMs: 100, sleep: async (ms) => { delays.push(ms) } })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  it('does not retry a non-transient failure', async () => {
    let calls = 0
    await expect(withAiRetries(async () => {
      calls++
      throw Object.assign(new Error('bad key'), { statusCode: 500 })
    }, { sleep: async () => {} })).rejects.toMatchObject({ statusCode: 500 })
    expect(calls).toBe(1)
  })

  it('gives up after the attempt cap with the last transient error', async () => {
    let calls = 0
    await expect(withAiRetries(async () => {
      calls++
      throw transient(`attempt ${calls}`)
    }, { attempts: 3, sleep: async () => {} })).rejects.toThrow('attempt 3')
    expect(calls).toBe(3)
  })

  it('classifies only 502-shaped errors as retryable', () => {
    expect(isRetryableAiError(transient())).toBe(true)
    expect(isRetryableAiError(Object.assign(new Error(), { statusCode: 503 }))).toBe(false)
    expect(isRetryableAiError(new Error('plain'))).toBe(false)
    expect(isRetryableAiError(null)).toBe(false)
  })
})
