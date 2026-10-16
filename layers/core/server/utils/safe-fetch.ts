// Outbound fetches of URLs that org admins configure (in multi-tenant mode,
// customers), e.g. helpinator's crawler and inbox grounding pages. A plain
// fetch would let them read loopback, private-network and cloud-metadata
// addresses through the stored content. Every hop refuses non-public
// addresses; redirects are followed by hand so each target is checked too;
// bodies are read as a stream and cut off at a byte cap.
//
// The check runs inside the socket's own DNS lookup (node:http's `lookup`
// hook, honoured by Bun too), and the socket connects to the addresses that
// passed it. There is no second resolution, so a DNS-rebinding host can't
// answer public for the check and private for the connect. TLS still
// verifies the certificate against the URL's hostname (SNI is the hostname).
//
// The `allowPrivate` option lifts the check (local development against a site
// on your own machine). Under VITEST loopback is allowed so the suite's
// in-process fixture site works; every other private range stays blocked
// there too.
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { pipeline, type Readable } from 'node:stream'
import zlib from 'node:zlib'

const MAX_REDIRECTS = 5

export class SafeFetchBlockedUrl extends Error {}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  return nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null
}

function isLoopback(ip: string): boolean {
  const v4 = ipv4Octets(ip)
  if (v4) return v4[0] === 127
  return ip.toLowerCase() === '::1'
}

function publicV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return false // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, broadcast
  return true
}

// Expand an IPv6 address to its eight 16-bit groups.
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const o = ipv4Octets(tail[1]!)
    if (!o) return null
    s = s.slice(0, -tail[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map(g => Number.parseInt(g, 16))
  return groups.length === 8 && groups.every(g => Number.isInteger(g) && g >= 0 && g <= 0xFFFF) ? groups : null
}

function publicV6(g: number[]): boolean {
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xFF, lo >> 8, lo & 0xFF]
  if (g.every(x => x === 0)) return false // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return false // ::1
  // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d): judge the IPv4.
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xFFFF || g[5] === 0)) return publicV4(embeddedV4(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xFF9B) return publicV4(embeddedV4(g[6]!, g[7]!)) // NAT64
  if (g[0] === 0x2002) return publicV4(embeddedV4(g[1]!, g[2]!)) // 6to4
  if ((g[0]! & 0xFE00) === 0xFC00) return false // unique local
  if ((g[0]! & 0xFFC0) === 0xFE80) return false // link-local
  if ((g[0]! & 0xFF00) === 0xFF00) return false // multicast
  if (g[0] === 0x2001 && g[1] === 0xDB8) return false // documentation
  return true
}

// Whether `ip` is a globally routable unicast address. Pure — exported for tests.
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const o = ipv4Octets(ip)
    return !!o && publicV4(o)
  }
  if (kind === 6) {
    const g = ipv6Groups(ip)
    return !!g && publicV6(g)
  }
  return false
}

function addressAllowed(ip: string, allowPrivate: boolean): boolean {
  if (allowPrivate) return true
  if (process.env.VITEST && isLoopback(ip)) return true
  return isPublicAddress(ip)
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '')
}

// Synchronous pre-check for admin input: rejects hosts that are obviously
// internal (IP literals in private ranges, localhost) before anything is
// stored. Hostnames are only fully checked at fetch time.
export function urlLooksPublic(raw: string, allowPrivate = false): boolean {
  if (allowPrivate) return true
  try {
    const u = new URL(raw)
    const host = bareHost(u).toLowerCase()
    if (isIP(host)) return addressAllowed(host, false)
    if (host === 'localhost' || host.endsWith('.localhost')) return !!process.env.VITEST
    return true
  } catch {
    return false
  }
}

// Protocol and IP-literal check. A literal never goes through `lookup`, so it
// is judged here; hostnames are judged by `checkedLookup` at connect time.
function assertFetchableUrl(u: URL, allowPrivate: boolean): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SafeFetchBlockedUrl('Only http(s) URLs can be fetched')
  const host = bareHost(u)
  if (isIP(host) && !addressAllowed(host, allowPrivate)) throw new SafeFetchBlockedUrl(`${host} is not a public address`)
}

// Resolve once and refuse unless every address is allowed. Returns the
// addresses the socket should connect to.
async function resolveAllowed(hostname: string, family: number | undefined, allowPrivate: boolean): Promise<{ address: string, family: number }[]> {
  let addresses: { address: string, family: number }[]
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new SafeFetchBlockedUrl(`Could not resolve ${hostname}`)
  }
  if (addresses.length === 0 || !addresses.every(a => addressAllowed(a.address, allowPrivate))) {
    throw new SafeFetchBlockedUrl(`${hostname} is not a public address`)
  }
  const wanted = family === 4 || family === 6 ? addresses.filter(a => a.family === family) : addresses
  if (wanted.length === 0) throw new SafeFetchBlockedUrl(`Could not resolve ${hostname}`)
  return wanted
}

function request(u: URL, headers: Record<string, string>, signal: AbortSignal, allowPrivate: boolean): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    // The socket's own DNS lookup: it connects to what passed the check. The
    // SafeFetchBlockedUrl is kept so the caller gets it, not a socket error.
    let blocked: SafeFetchBlockedUrl | null = null
    const checkedLookup: LookupFunction = (hostname, options, callback) => {
      resolveAllowed(hostname, options.family as number | undefined, allowPrivate).then(
        (addrs) => {
          if (options.all) callback(null, addrs)
          else callback(null, addrs[0]!.address, addrs[0]!.family)
        },
        (err: SafeFetchBlockedUrl) => {
          blocked = err
          callback(err, '', 0)
        }
      )
    }
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'GET',
      headers: { 'accept-encoding': 'gzip, deflate, br', ...headers },
      lookup: checkedLookup,
      // A fresh socket per request: a pooled one would skip the lookup.
      agent: false,
      signal
    }, resolve)
    req.on('error', err => reject(blocked ?? err))
    req.end()
  })
}

// The response body, decompressed per content-encoding.
function bodyStream(res: http.IncomingMessage): Readable {
  const decoder = {
    'gzip': zlib.createGunzip, 'x-gzip': zlib.createGunzip, 'deflate': zlib.createInflate, 'br': zlib.createBrotliDecompress
  }[(res.headers['content-encoding'] ?? '').trim().toLowerCase()]
  return decoder ? pipeline(res, decoder(), () => {}) : res
}

export interface SafeFetched {
  status: number
  contentType: string
  finalUrl: string
  // null when the body was over the cap, or `wantBody` rejected the response.
  body: string | null
  // The body was wanted but passed `maxBytes`, so it was not read.
  tooLarge: boolean
}

// GET `url`, following up to MAX_REDIRECTS redirects, each target checked.
// `wantBody(status, contentType)` decides whether the body is read at all.
export async function safeFetch(
  url: string,
  opts: {
    headers: Record<string, string>
    timeoutMs: number
    maxBytes: number
    wantBody?: (status: number, contentType: string) => boolean
    allowPrivate?: boolean
  }
): Promise<SafeFetched> {
  const allowPrivate = opts.allowPrivate ?? false
  const signal = AbortSignal.timeout(opts.timeoutMs)
  let current = new URL(url)
  for (let hop = 0; ; hop++) {
    assertFetchableUrl(current, allowPrivate)
    const res = await request(current, opts.headers, signal, allowPrivate)
    const status = res.statusCode ?? 0
    const location = res.headers.location
    if (status >= 300 && status < 400 && location) {
      res.destroy()
      if (hop >= MAX_REDIRECTS) throw new SafeFetchBlockedUrl('Too many redirects')
      current = new URL(location, current)
      continue
    }
    const contentType = res.headers['content-type'] ?? ''
    const finalUrl = current.toString()
    if (opts.wantBody && !opts.wantBody(status, contentType)) {
      res.destroy()
      return { status, contentType, finalUrl, body: null, tooLarge: false }
    }
    const body = await readCapped(res, opts.maxBytes)
    return { status, contentType, finalUrl, body, tooLarge: body === null }
  }
}

// The body as text, or null once it passes `maxBytes` (the rest is never
// read). The cap counts decompressed bytes, so a small gzip bomb can't
// expand past it.
async function readCapped(res: http.IncomingMessage, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers['content-length'])
  if (!res.headers['content-encoding'] && Number.isFinite(declared) && declared > maxBytes) {
    res.destroy()
    return null
  }
  const stream = bodyStream(res)
  const parts: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      total += buf.byteLength
      if (total > maxBytes) return null
      parts.push(buf)
    }
  } finally {
    stream.destroy()
    res.destroy()
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}
