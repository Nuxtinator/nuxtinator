// Thin client for the public helpinator API. All calls are cross-origin with a
// bearer session token (never cookies).

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function errorFrom(res) {
  let message = 'Something went wrong — please try again.'
  try {
    const body = await res.json()
    message = body.statusMessage || body.message || message
  } catch { /* not JSON */ }
  return new ApiError(res.status, message)
}

export function createApi(host, widgetId) {
  const base = `${String(host || '').replace(/\/+$/, '')}/api/v1/helpinator/widgets/${encodeURIComponent(widgetId)}`

  function headers(token, extra = {}) {
    const h = { ...extra }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  async function json(path, { method = 'GET', token, body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(token, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    })
    if (!res.ok) throw await errorFrom(res)
    return await res.json()
  }

  return {
    config: () => json('/config'),
    conversation: token => json('/conversation', { token }),
    handoff: (token, email) => json('/handoff', { method: 'POST', token, body: { email } }),

    // One turn, streamed. `on` receives each server-sent event by name.
    async send(token, message, pageUrl, on) {
      const res = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: headers(token, { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }),
        body: JSON.stringify({ message, pageUrl })
      })
      if (!res.ok) throw await errorFrom(res)
      if (!res.body || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
        on('done', await res.json())
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          let name = 'message'
          const data = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
          }
          if (!data.length) continue
          let payload
          try {
            payload = JSON.parse(data.join('\n'))
          } catch {
            continue
          }
          on(name, payload)
        }
      }
    }
  }
}
