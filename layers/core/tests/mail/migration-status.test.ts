// migrationsReady: settled once per boot by the migrations plugin. Tested as
// a unit, and by running the plugin itself with Nitro's globals stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrationsReady, settleMigrations } from '../../server/utils/migration-status'

const READY = Symbol.for('nuxtinator.migrations.ready')
const HELD = Symbol.for('nuxtinator.migrations.held-back')

function freshState() {
  const g = globalThis as Record<symbol, unknown>
  delete g[READY]
  delete g[HELD]
}

beforeEach(freshState)
afterEach(() => {
  freshState()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('settleMigrations', () => {
  it('resolves with the outcome, for callers that asked before and after', async () => {
    const early = migrationsReady()
    settleMigrations({ database: false })
    await expect(early).resolves.toEqual({ database: false })
    await expect(migrationsReady()).resolves.toEqual({ database: false })
  })

  it('rejects with the error, and only the first settle counts', async () => {
    const err = new Error('boom')
    settleMigrations({ error: err })
    settleMigrations({ database: true })
    await expect(migrationsReady()).rejects.toBe(err)
  })

  it('a rejection nobody awaits is not an unhandled rejection', async () => {
    settleMigrations({ error: new Error('unobserved') })
    await new Promise(r => setTimeout(r, 20))
  })
})

describe('the migrations plugin settles migrationsReady on every path', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function runPlugin(config: Record<string, unknown>) {
    vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
    vi.stubGlobal('useRuntimeConfig', () => config)
    vi.resetModules()
    const plugin = (await import('../../server/plugins/migrations')).default as unknown as () => Promise<void>
    return plugin()
  }

  it('resolves with database: false when there is no DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', '')
    await runPlugin({ databaseUrl: '' })
    await expect(migrationsReady()).resolves.toEqual({ database: false })
  })

  it('resolves with database: true when there is nothing to migrate', async () => {
    await runPlugin({ databaseUrl: process.env.TEST_DATABASE_URL, layerMigrationPaths: [], tenancyMigrationPaths: [], migrationRequiredExtensions: {} })
    await expect(migrationsReady()).resolves.toEqual({ database: true })
  })

  it('rejects when a migration throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'test-core-mail-migrations-'))
    try {
      await writeFile(join(dir, 'zzzz_test_core_mail_throws.mjs'), 'export async function up() { throw new Error(\'test-core-mail migration failed\') }\n')
      await expect(runPlugin({ databaseUrl: process.env.TEST_DATABASE_URL, layerMigrationPaths: [dir], tenancyMigrationPaths: [], migrationRequiredExtensions: {} }))
        .rejects.toThrow('test-core-mail migration failed')
      await expect(migrationsReady()).rejects.toThrow('test-core-mail migration failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
