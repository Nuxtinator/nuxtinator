// Pure channel-value normalization. Every address that enters the channel
// service passes through here so that one identity ("JD <JD@Example.com>",
// "jd@example.com") always resolves to the same address identity. The
// kernel uses the url format for link fields; the crm layer's channel
// service uses all five. No DB, no I/O — safe to call from validation paths,
// seeds and tests alike.

import { createHash } from 'node:crypto'

/** The five code-owned value formats (the crm mirrors them in a CHECK constraint). */
export type ChannelValueFormat = 'email' | 'phone' | 'handle' | 'url' | 'freeform'

export interface NormalizedChannelValue {
  /** Canonical comparable form of the raw input. */
  normalized: string
  /** False when the input can't be a value of this format. */
  valid: boolean
}

function normalizeEmail(raw: string): NormalizedChannelValue {
  let v = raw.trim()
  // Strip a display-name wrapper ("Jane Doe <jane@example.com>").
  const angled = v.match(/<([^<>]*)>\s*$/)
  if (angled) v = angled[1]!.trim()
  if (v.toLowerCase().startsWith('mailto:')) v = v.slice(7)
  v = v.toLowerCase()
  return { normalized: v, valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) }
}

// Digits plus an optional leading +. Length bounds follow E.164 (7–15
// digits); no libphonenumber-style regional parsing in v1.
function normalizePhone(raw: string): NormalizedChannelValue {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  const normalized = (trimmed.startsWith('+') ? '+' : '') + digits
  return { normalized, valid: digits.length >= 7 && digits.length <= 15 }
}

function normalizeUrl(raw: string): NormalizedChannelValue {
  let v = raw.trim()
  if (v !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`
  try {
    const url = new URL(v)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { normalized: v, valid: false }
    }
    const valid = url.hostname === 'localhost' || url.hostname.includes('.')
    return { normalized: url.href, valid }
  } catch {
    return { normalized: v, valid: false }
  }
}

function normalizeHandle(raw: string): NormalizedChannelValue {
  let v = raw.trim()
  if (v.startsWith('@')) v = v.slice(1)
  v = v.toLowerCase()
  return { normalized: v, valid: v.length > 0 && !/\s/.test(v) }
}

function normalizeFreeform(raw: string): NormalizedChannelValue {
  const v = raw.trim()
  return { normalized: v, valid: v.length > 0 }
}

export function normalizeChannelValue(format: ChannelValueFormat, raw: string): NormalizedChannelValue {
  switch (format) {
    case 'email':
      return normalizeEmail(raw)
    case 'phone':
      return normalizePhone(raw)
    case 'url':
      return normalizeUrl(raw)
    case 'handle':
      return normalizeHandle(raw)
    case 'freeform':
      return normalizeFreeform(raw)
  }
}

// Stable identity of an address independent of the crm_channels row — stored
// on consent events so the compliance trail survives channel erasure.
export function channelFingerprint(type: string, normalized: string): string {
  return createHash('sha256').update(`${type}:${normalized}`).digest('hex')
}
