// safeFetch resolves a host once, checks it, and connects to what
// it checked (no second lookup a DNS-rebinding host could answer differently).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'

const answers = vi.hoisted(() => ({ calls: 0, next: [] as string[][] }))
vi.mock('node:dns/promises', async (orig) => {
  const real = await orig<typeof import('node:dns/promises')>()
  const lookup = async () => {
    answers.calls++
    return (answers.next.shift() ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { ...real, lookup, default: { ...real, lookup } }
})

const { safeFetch, SafeFetchBlockedUrl } = await import('../../server/utils/safe-fetch')

let server: Server
let port: number
const seenHosts: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHosts.push(req.headers.host ?? '')
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>hi</p>')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
afterAll(() => server.close())
beforeEach(() => {
  answers.calls = 0
  answers.next = []
  seenHosts.length = 0
})

const opts = { headers: {}, timeoutMs: 5000, maxBytes: 10_000 }

describe('safeFetch address pinning', () => {
  it('connects to the address it checked, resolving once, with the original Host', async () => {
    // A second answer would be the rebinding one; it must never be asked for.
    answers.next = [['127.0.0.1'], ['10.0.0.1']]
    const res = await safeFetch(`http://rebind.test:${port}/`, opts)
    expect(res.status).toBe(200)
    expect(res.body).toContain('hi')
    expect(answers.calls).toBe(1)
    expect(seenHosts).toEqual([`rebind.test:${port}`])
  })

  it('refuses a host whose answer is private, without connecting', async () => {
    answers.next = [['10.0.0.1']]
    await expect(safeFetch(`http://rebind.test:${port}/`, opts)).rejects.toBeInstanceOf(SafeFetchBlockedUrl)
    expect(seenHosts).toEqual([])
  })

  it('refuses when any of several answers is private', async () => {
    answers.next = [['127.0.0.1', '169.254.169.254']]
    await expect(safeFetch(`http://rebind.test:${port}/`, opts)).rejects.toBeInstanceOf(SafeFetchBlockedUrl)
    expect(seenHosts).toEqual([])
  })
})
