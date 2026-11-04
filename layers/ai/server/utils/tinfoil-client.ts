// Transport to Tinfoil's confidential inference. Every request goes through the
// SDK's `SecureClient`: it verifies the enclave's attestation first and then
// encrypts each request body to the attested key (EHBP), so only the verified
// enclave can read prompts, images or audio. A failed verification refuses the
// request rather than falling back to plain HTTPS.
//
// One client per process, held on a global symbol (Nitro may load this module
// more than once); attestation runs once and is reused until a failure resets it.
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { SecureClient } from 'tinfoil'

const STATE_KEY = Symbol.for('nuxtinator.ai.tinfoil-client')

function getClient(): SecureClient {
  const g = globalThis as Record<symbol, unknown>
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = new SecureClient({
      // Scopes Tinfoil's prompt cache to this deployment. Passed explicitly so
      // the SDK never tries to persist one under the server's home directory.
      userCacheSecret: process.env.TINFOIL_USER_CACHE_SECRET || randomBytes(32).toString('hex')
    })
  }
  return g[STATE_KEY] as SecureClient
}

// Fetch `path` (e.g. '/v1/chat/completions') on the attested enclave. Network
// and attestation failures surface as 502 so the caller's retry policy applies.
export async function tinfoilFetch(apiKey: string, path: string, init: RequestInit): Promise<Response> {
  const client = getClient()
  try {
    await client.ready()
  } catch (err) {
    client.reset()
    console.error('[ai] Tinfoil attestation failed:', (err as Error)?.message ?? err)
    throw createError({ statusCode: 502, statusMessage: 'Could not verify the Tinfoil enclave. Try again in a moment.' })
  }
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${apiKey}`)
  try {
    return await client.fetch(path, { ...init, headers })
  } catch (err) {
    console.error('[ai] Tinfoil request failed:', (err as Error)?.message ?? err)
    throw createError({ statusCode: 502, statusMessage: 'AI request failed to reach the provider. Try again in a moment.' })
  }
}
