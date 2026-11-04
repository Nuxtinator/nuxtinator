import type { H3Event } from 'h3'

const IDLE_TIMEOUT_MS = 30_000
const LINGER_MS = 2_000

// Reads the request body with a size cap (413) and an idle timeout (408), and
// caches it on the event so h3's body readers reuse it.
export function readBodyWithLimit(event: H3Event, limit: number, message = 'Request body too large'): Promise<Buffer> {
  const req = event.node.req
  // After the error response, discards incoming bytes briefly so the client can read it, then closes.
  const fail = (statusCode: number, statusMessage: string) => {
    req.removeAllListeners('data')
    event.node.res.once('finish', () => {
      req.resume()
      setTimeout(() => req.destroy(), LINGER_MS).unref()
    })
    return createError({ statusCode, statusMessage })
  }
  if (Number(getHeader(event, 'content-length')) > limit) return Promise.reject(fail(413, message))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let idle = setTimeout(() => reject(fail(408, 'Request body timed out')), IDLE_TIMEOUT_MS)
    const restartIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(() => reject(fail(408, 'Request body timed out')), IDLE_TIMEOUT_MS)
    }
    req.on('data', (chunk: Buffer) => {
      restartIdle()
      total += chunk.length
      if (total > limit) {
        clearTimeout(idle)
        reject(fail(413, message))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(idle)
      const body = Buffer.concat(chunks)
      event._requestBody = body
      resolve(body)
    })
    req.on('error', (err) => {
      clearTimeout(idle)
      reject(err)
    })
  })
}
