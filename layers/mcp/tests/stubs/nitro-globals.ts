// Tests run outside Nitro, so we stub the auto-imported globals the layer
// uses (`useStorage`, `useRuntimeConfig`, `createError`, `getHeader`,
// `setResponseHeader`, `readRawBody`). Vitest's setup file populates these
// onto globalThis so layer code that references them at runtime resolves.
//
// Two tunables tests can drive:
//   - `setTestRuntimeConfig({ ... })`: shape of useRuntimeConfig() return.
//   - `setTestStorage({ ... })`: an in-memory map keyed by storage key.

interface RuntimeConfig {
  mcpServerName?: string
  mcpServerVersion?: string
  mcpReadScopes?: string[]
  mcpRateLimits?: Record<string, unknown>
  mcpAdditionalOrigins?: string[]
  mcpDisabledApps?: string[]
  mcpDisabledTools?: string[]
  [key: string]: unknown
}

let _runtimeConfig: RuntimeConfig = {}

export function setTestRuntimeConfig(cfg: RuntimeConfig): void {
  _runtimeConfig = cfg
}

export function getTestRuntimeConfig(): RuntimeConfig {
  return _runtimeConfig
}

const _storage = new Map<string, unknown>()

export function clearTestStorage(): void {
  _storage.clear()
}

export function getTestStorage(): Map<string, unknown> {
  return _storage
}

interface H3LikeError extends Error {
  statusCode: number
  statusMessage?: string
  data?: unknown
}

export interface InstalledGlobals {
  useStorage: () => {
    getItem: <T>(key: string) => Promise<T | null>
    setItem: (key: string, value: unknown, opts?: unknown) => Promise<void>
    removeItem: (key: string) => Promise<void>
  }
  useRuntimeConfig: () => RuntimeConfig
  createError: (opts: { statusCode: number, statusMessage?: string, data?: unknown }) => H3LikeError
  getHeader: (event: { headers?: Record<string, string> }, name: string) => string | undefined
  setResponseHeader: (event: unknown, name: string, value: string) => void
}

export function installNitroGlobals(): InstalledGlobals {
  const installed: InstalledGlobals = {
    useStorage: () => ({
      getItem: async <T>(key: string): Promise<T | null> => {
        return (_storage.get(key) as T) ?? null
      },
      setItem: async (key: string, value: unknown) => {
        _storage.set(key, value)
      },
      removeItem: async (key: string) => {
        _storage.delete(key)
      }
    }),
    useRuntimeConfig: () => _runtimeConfig,
    createError: (opts) => {
      const err = new Error(opts.statusMessage ?? 'error') as H3LikeError
      err.statusCode = opts.statusCode
      err.statusMessage = opts.statusMessage
      err.data = opts.data
      return err
    },
    getHeader: (event, name) => {
      return event?.headers?.[name.toLowerCase()]
    },
    setResponseHeader: () => {
      // no-op for tests
    }
  }

  for (const [k, v] of Object.entries(installed)) {
    ;(globalThis as Record<string, unknown>)[k] = v
  }

  return installed
}
