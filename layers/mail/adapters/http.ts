// Shared HTTP plumbing for the provider adapters.

export interface HttpResult {
  status: number
  ok: boolean
  text: string
  json: () => unknown
}

// fetch with a manually cleared timeout (AbortSignal.timeout leaks timers
// under Bun). An outer signal, when given, aborts it too.
export async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  const controller = new AbortController()
  const outer = init.signal
  const onAbort = () => controller.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    return {
      status: res.status,
      ok: res.ok,
      text,
      json: () => {
        try {
          return JSON.parse(text)
        } catch {
          return {}
        }
      }
    }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

export function baseUrl(host: string | undefined, fallback: string): string {
  const h = (host || fallback).replace(/\/$/, '')
  return /^https?:\/\//.test(h) ? h : `https://${h}`
}

export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

export function lowerHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k.toLowerCase()] = v
  return out
}

// Parses an urlencoded or multipart form body.
export async function parseForm(rawBody: Buffer, contentType: string | undefined): Promise<Map<string, string | File>> {
  const out = new Map<string, string | File>()
  const ct = contentType ?? ''
  if (ct.includes('multipart/form-data')) {
    const form = await new Response(new Uint8Array(rawBody), { headers: { 'content-type': ct } }).formData()
    for (const [key, value] of form.entries()) if (!out.has(key)) out.set(key, value as string | File)
    return out
  }
  for (const [key, value] of new URLSearchParams(rawBody.toString('utf8'))) if (!out.has(key)) out.set(key, value)
  return out
}

export function formString(form: Map<string, string | File>, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v : ''
}
