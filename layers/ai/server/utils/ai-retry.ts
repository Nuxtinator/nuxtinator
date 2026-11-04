// Retry policy for provider round trips. The client maps transient trouble
// (rate limits, provider 5xx, connection failures, an upstream error carried
// in a 200 body) to a 502; those are retried with linear backoff, everything
// else surfaces at once. Only whole, non-streaming calls are wrapped — a
// stream that has already handed text to the caller cannot be replayed.

export const AI_MAX_ATTEMPTS = 3
export const AI_RETRY_BASE_MS = 500

export function isRetryableAiError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { statusCode?: unknown }).statusCode === 502
}

export interface AiRetryOptions {
  attempts?: number
  baseMs?: number
  sleep?: (ms: number) => Promise<void>
}

export async function withAiRetries<T>(fn: () => Promise<T>, opts: AiRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? AI_MAX_ATTEMPTS)
  const baseMs = opts.baseMs ?? AI_RETRY_BASE_MS
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryableAiError(err) || attempt >= attempts) throw err
      await sleep(baseMs * attempt)
    }
  }
}
