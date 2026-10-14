import type { H3Event } from 'h3'

// Reads the request body into memory, failing with 413 once it passes `limit`
// bytes, whether or not the client declared a Content-Length. The body is
// cached on the event, so h3's readers (readMultipartFormData, readBody) use it
// instead of reading the request again.
export function readBodyWithLimit(event: H3Event, limit: number, message = 'Request body too large'): Promise<Buffer> {
  const tooLarge = () => createError({ statusCode: 413, statusMessage: message })
  if (Number(getHeader(event, 'content-length')) > limit) return Promise.reject(tooLarge())
  const req = event.node.req
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        req.removeAllListeners('data')
        req.pause()
        // Close the connection after the 413 instead of draining the rest of the body.
        event.node.res.once('finish', () => req.destroy())
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      event._requestBody = body
      resolve(body)
    })
    req.on('error', reject)
  })
}
