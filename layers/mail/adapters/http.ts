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

let endpointCheck: ((url: URL) => boolean) | null = null

// Tests only: replaces the provider-host check on endpoint overrides. null restores it.
export function __setEndpointCheck(fn: ((url: URL) => boolean) | null): void {
  endpointCheck = fn
}

export class EndpointError extends Error {}

// A configured API endpoint, accepted only as https on one of the provider's
// own hosts: org admins can set it, so anything else would let them aim the
// server's requests (and the key) elsewhere.
export function providerEndpoint(value: string | undefined, allowedHost: RegExp, label: string): string | null {
  if (!value) return null
  const raw = value.trim().replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new EndpointError(`The ${label} endpoint isn't a valid URL`)
  }
  const ok = endpointCheck
    ? endpointCheck(url)
    : url.protocol === 'https:' && allowedHost.test(url.hostname) && !url.port && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search
  if (!ok) throw new EndpointError(`The ${label} endpoint must be an https URL on ${label}'s own API host`)
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
}

export function baseUrl(host: string | undefined, fallback: string, allowedHost: RegExp, label: string): string {
  return providerEndpoint(host, allowedHost, label) ?? `https://${fallback}`
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
