import { BlockList, isIP } from 'node:net'
import type { H3Event } from 'h3'
import { getRequestHeader } from 'h3'

// The client's IP for rate limiting.
//
// X-Forwarded-For's leftmost entries are whatever the client sent, so keying on
// them lets anyone pick a fresh identity per request. Counting hops from the
// right doesn't fix that either: behind Cloudflare the entry one hop in is a
// Cloudflare edge shared by many clients, and a request that skips a proxy
// shifts every position by one.
//
// So we trust addresses, not positions. Start at the socket peer; while that
// address is a proxy we trust (runtimeConfig.trustedProxies), step one entry
// left in X-Forwarded-For. The first untrusted address is the client. A forged
// entry can only be reached by passing through the real client's address,
// which is never trusted, so it is never reached. When the socket peer itself
// is untrusted (no proxy in front), the header is ignored entirely.

// https://www.cloudflare.com/ips/ — last checked 2026-10-05.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32'
]

const PRESETS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  // RFC 1918, carrier-grade NAT (what many PaaS edges use internally),
  // link-local, IPv6 unique-local. None is reachable from the public internet.
  private: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'],
  cloudflare: CLOUDFLARE
}

export const DEFAULT_TRUSTED_PROXIES = 'loopback,private,cloudflare'

// "1.2.3.4", "1.2.3.4:5678", "[::1]:80", "::ffff:1.2.3.4" → the bare address.
function normalize(raw: string): string {
  let s = raw.trim()
  const bracketed = s.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) s = bracketed[1]!
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'))
  if (s.toLowerCase().startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7)
  return s
}

// Build the matcher from a comma-separated list of preset names and CIDRs or
// bare addresses, e.g. "loopback,private,cloudflare,203.0.113.10".
export function buildTrustedProxies(spec: string): BlockList {
  const list = new BlockList()
  for (const item of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    for (const entry of PRESETS[item.toLowerCase()] ?? [item]) {
      const [addr, prefix] = entry.split('/')
      const type = isIP(addr!)
      if (!type) throw new Error(`trustedProxies: "${entry}" is not a preset, IP address or CIDR`)
      const family = type === 4 ? 'ipv4' : 'ipv6'
      if (prefix === undefined) list.addAddress(addr!, family)
      else list.addSubnet(addr!, Number(prefix), family)
    }
  }
  return list
}

function isTrusted(list: BlockList, addr: string): boolean {
  const type = isIP(addr)
  return type !== 0 && list.check(addr, type === 4 ? 'ipv4' : 'ipv6')
}

export function resolveClientIp(socketIp: string | undefined, forwardedFor: string | undefined, trusted: BlockList): string {
  let current = socketIp ? normalize(socketIp) : ''
  if (!current) return 'unknown'
  const chain = (forwardedFor ?? '').split(',').map(normalize).filter(Boolean)
  while (isTrusted(trusted, current) && chain.length > 0) current = chain.pop()!
  return current
}

let cached: { spec: string, list: BlockList } | null = null

export function getClientIp(event: H3Event): string {
  const spec = String(useRuntimeConfig().trustedProxies ?? DEFAULT_TRUSTED_PROXIES)
  if (cached?.spec !== spec) cached = { spec, list: buildTrustedProxies(spec) }
  return resolveClientIp(event.node.req.socket?.remoteAddress, getRequestHeader(event, 'x-forwarded-for'), cached.list)
}
