// Pure coverage for the crawler's address filter (the SSRF guard).
import { describe, it, expect } from 'vitest'
import { isPublicAddress } from '../../server/utils/safe-fetch'

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, metadata and reserved IPv4', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('refuses the IPv6 equivalents, including IPv4 hidden inside IPv6', () => {
    for (const ip of ['::', '::1', 'fe80::1', 'fd00::1', 'fc12:3456::1', 'ff02::1', '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:0a00:0001::1', '::10.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:0808:0808::1']) {
      expect(isPublicAddress(ip), ip).toBe(true)
    }
  })

  it('refuses anything that is not an IP', () => {
    expect(isPublicAddress('example.com')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
  })
})
