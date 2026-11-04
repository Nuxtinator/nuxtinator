// Allowed-origin entries for widgets. An entry is either an exact origin
// (`https://www.example.org`) or a subdomain wildcard (`https://*.example.org`).
// A wildcard matches any depth of subdomain under the base domain, on the same
// scheme and port, but not the base domain itself — list that separately, as
// in CSP. Pure functions so they can be unit-tested without a server.
import { getPublicSuffix } from 'tldts'

const WILDCARD_RE = /^(https?):\/\/\*\.(.+)$/i
// Stand-in label so URL() can parse and normalize the rest of a wildcard entry.
const PLACEHOLDER = 'helpinator-wildcard'

// Normalize one entry to `scheme://host[:port]` or `scheme://*.domain[:port]`.
// Returns null when the entry is not a usable origin or wildcard.
export function helpinatorParseOriginEntry(raw: string): string | null {
  const trimmed = raw.trim()
  const wild = WILDCARD_RE.exec(trimmed)
  let u: URL
  try {
    u = new URL(wild ? `${wild[1]}://${PLACEHOLDER}.${wild[2]}` : trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (u.hostname.includes('*')) return null
  if (!wild) return u.origin

  // The wildcard must be the whole first label of a registrable domain:
  // `*.example.org` yes; `*.org`, `*.127.0.0.1`, `*.[::1]` no. Public suffixes
  // are refused too, including shared hosts like github.io or vercel.app,
  // where anyone can publish a subdomain.
  if (!u.hostname.startsWith(`${PLACEHOLDER}.`)) return null
  const base = u.hostname.slice(PLACEHOLDER.length + 1)
  if (base.startsWith('[') || /^[\d.]+$/.test(base)) return null
  if (base.split('.').filter(Boolean).length < 2) return null
  if (getPublicSuffix(base, { allowPrivateDomains: true }) === base) return null
  return `${u.protocol}//*.${base}${u.port ? `:${u.port}` : ''}`
}

// Whether a request origin (already normalized by URL().origin) is covered by
// one of the widget's stored entries.
export function helpinatorOriginAllowed(origin: string, entries: readonly string[]): boolean {
  if (entries.includes(origin)) return true
  let req: URL
  try {
    req = new URL(origin)
  } catch {
    return false
  }
  for (const entry of entries) {
    const wild = WILDCARD_RE.exec(entry)
    if (!wild) continue
    const pattern = new URL(`${wild[1]}://${PLACEHOLDER}.${wild[2]}`)
    if (pattern.protocol !== req.protocol || pattern.port !== req.port) continue
    const base = pattern.hostname.slice(PLACEHOLDER.length + 1)
    if (req.hostname.endsWith(`.${base}`)) return true
  }
  return false
}
