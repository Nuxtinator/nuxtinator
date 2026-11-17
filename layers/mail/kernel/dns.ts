import { promises as dns } from 'node:dns'

// The DNS lookups the kernel makes. Injectable, so tests and fake setups can
// answer without real records.
export interface DnsLookup {
  txt: (name: string) => Promise<string[]>
  mx: (name: string) => Promise<{ exchange: string, priority: number }[]>
  cname: (name: string) => Promise<string[]>
}

function empty(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'NXDOMAIN'
}

export const systemDns: DnsLookup = {
  txt: async (name) => {
    try {
      return (await dns.resolveTxt(name)).map(parts => parts.join(''))
    } catch (err) {
      if (empty(err)) return []
      throw err
    }
  },
  mx: async (name) => {
    try {
      return await dns.resolveMx(name)
    } catch (err) {
      if (empty(err)) return []
      throw err
    }
  },
  cname: async (name) => {
    try {
      return await dns.resolveCname(name)
    } catch (err) {
      if (empty(err)) return []
      throw err
    }
  }
}

// An in-memory resolver for tests and local setups.
export function memoryDns(records: Map<string, { txt?: string[], mx?: { exchange: string, priority: number }[], cname?: string[] }> = new Map()): DnsLookup & { records: typeof records } {
  const at = (name: string) => records.get(name.toLowerCase()) ?? {}
  return {
    records,
    txt: async name => at(name).txt ?? [],
    mx: async name => at(name).mx ?? [],
    cname: async name => at(name).cname ?? []
  }
}
