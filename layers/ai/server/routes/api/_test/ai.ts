// Test-only control endpoint for the AI fake. Serves only under VITEST; in any
// other process it is a 404, and the fake is never installed there either.
//
// POST   — script the next answers: `{ text?, toolCalls?, generateInput?, transcript?, decisions? }`
// GET    — the log of calls served since the last reset
// DELETE — clear the script and the log
import { primeAiFake, getAiFakeLog, resetAiFake, type AiFakeScript } from '../../../utils/ai-test-fake'

export default defineEventHandler(async (event) => {
  if (!process.env.VITEST) {
    throw createError({ statusCode: 404, statusMessage: 'Not found' })
  }
  if (event.method === 'POST') {
    primeAiFake((await readBody(event)) as AiFakeScript)
    return { ok: true }
  }
  if (event.method === 'GET') {
    return getAiFakeLog()
  }
  if (event.method === 'DELETE') {
    resetAiFake()
    return { ok: true }
  }
  throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
})
