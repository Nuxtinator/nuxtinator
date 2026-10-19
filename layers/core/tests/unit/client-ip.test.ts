// Pure coverage for the rate-limit client identity. The live server in the API
// tests always sees a loopback peer, so the "nothing in front of the app" and
// "behind Cloudflare" shapes are only reachable here.
import { describe, it, expect } from 'vitest'
import { buildTrustedProxies, resolveClientIp, DEFAULT_TRUSTED_PROXIES } from '../../server/utils/client-ip'

const defaults = buildTrustedProxies(DEFAULT_TRUSTED_PROXIES)
const withCloudflare = buildTrustedProxies('private,cloudflare')
const withoutCloudflare = buildTrustedProxies('loopback,private')

const CLIENT = '203.0.113.77'
const CF_EDGE = '172.70.1.2'
const PAAS_INGRESS = '10.244.0.9'

describe('resolveClientIp', () => {
  it('with no proxy in front, ignores X-Forwarded-For entirely — even a single entry', () => {
    expect(resolveClientIp(CLIENT, '198.51.100.1', defaults)).toBe(CLIENT)
    expect(resolveClientIp(CLIENT, '10.0.0.1, 198.51.100.1', defaults)).toBe(CLIENT)
  })

  it('behind a private proxy, takes the address it appended, not what the client sent', () => {
    expect(resolveClientIp(PAAS_INGRESS, CLIENT, defaults)).toBe(CLIENT)
    expect(resolveClientIp(PAAS_INGRESS, `1.1.1.1, 10.9.9.9, ${CLIENT}`, defaults)).toBe(CLIENT)
  })

  it('behind Cloudflare, steps past the shared edge to the client', () => {
    expect(resolveClientIp(PAAS_INGRESS, `${CLIENT}, ${CF_EDGE}`, withCloudflare)).toBe(CLIENT)
    expect(resolveClientIp(CF_EDGE, CLIENT, withCloudflare)).toBe(CLIENT)
    // Two Cloudflare hops (a proxied custom domain in front of a platform that
    // itself sits behind Cloudflare).
    expect(resolveClientIp(PAAS_INGRESS, `${CLIENT}, 162.158.4.4, ${CF_EDGE}`, withCloudflare)).toBe(CLIENT)
  })

  it('a request that skips Cloudflare still cannot pick its identity', () => {
    // Forged entries, including a fake Cloudflare one, sit left of the
    // attacker's real address, which the ingress appended and nobody trusts.
    expect(resolveClientIp(PAAS_INGRESS, `9.9.9.9, ${CF_EDGE}, ${CLIENT}`, withCloudflare)).toBe(CLIENT)
    expect(resolveClientIp(CLIENT, `9.9.9.9, ${CF_EDGE}`, withCloudflare)).toBe(CLIENT)
  })

  it('trusts Cloudflare by default', () => {
    expect(resolveClientIp(PAAS_INGRESS, `${CLIENT}, ${CF_EDGE}`, defaults)).toBe(CLIENT)
  })

  it('without the cloudflare preset, a Cloudflare edge is the client — the setting is what matters', () => {
    expect(resolveClientIp(PAAS_INGRESS, `${CLIENT}, ${CF_EDGE}`, withoutCloudflare)).toBe(CF_EDGE)
  })

  it('normalizes ports, brackets and IPv4-mapped IPv6', () => {
    expect(resolveClientIp('::ffff:10.0.0.5', `${CLIENT}:51234`, defaults)).toBe(CLIENT)
    expect(resolveClientIp('::1', '[2001:db8::7]:443', defaults)).toBe('2001:db8::7')
    expect(resolveClientIp('::ffff:203.0.113.77', '10.0.0.1', defaults)).toBe(CLIENT)
  })

  it('stops at a garbage entry instead of skipping it', () => {
    expect(resolveClientIp(PAAS_INGRESS, `${CLIENT}, not-an-ip`, defaults)).toBe('not-an-ip')
  })

  it('falls back to "unknown" with no socket address', () => {
    expect(resolveClientIp(undefined, CLIENT, defaults)).toBe('unknown')
  })
})

describe('buildTrustedProxies', () => {
  it('accepts bare addresses and CIDRs alongside presets', () => {
    const list = buildTrustedProxies('loopback, 198.51.100.0/24, 2001:db8::1')
    expect(resolveClientIp('198.51.100.20', CLIENT, list)).toBe(CLIENT)
    expect(resolveClientIp('2001:db8::1', CLIENT, list)).toBe(CLIENT)
    expect(resolveClientIp('2001:db8::2', CLIENT, list)).toBe('2001:db8::2')
  })

  it('rejects a typo rather than silently trusting nothing', () => {
    expect(() => buildTrustedProxies('loopback,cloudfare')).toThrow(/cloudfare/)
  })
})
