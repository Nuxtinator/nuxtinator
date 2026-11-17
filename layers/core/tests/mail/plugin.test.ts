// Core's mail plugin and #core/server/utils/mail, run with Nitro's globals
// stubbed and the database pointed at a schema of their own, so the booted
// server's env account is never touched.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { outboxKeyPair } from '@nuxtinator/mail/kernel'
import { createFakeProvider, type FakeProvider } from '@nuxtinator/mail/test'

const SCHEMA = 'core_mail_plugin_test'
const SECRET = 'c'.repeat(64)

const ctl = await vi.hoisted(async () => {
  const { Kysely } = await import('kysely')
  const { PostgresJSDialect } = await import('kysely-postgres-js')
  const postgres = (await import('postgres')).default
  const db = new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(process.env.TEST_DATABASE_URL!, {
        prepare: false,
        onnotice: () => {},
        max: 4,
        connection: { search_path: 'core_mail_plugin_test,public' }
      })
    })
  })
  return {
    db,
    migrations: null as null | { promise: Promise<{ database: boolean }>, resolve: (o: { database: boolean }) => void, reject: (e: unknown) => void },
    cron: null as null | (() => Promise<void>),
    fakeState: { provider: null as FakeProvider | null, dns: null as unknown }
  }
})

vi.mock('#core/server/utils/database', () => ({ db: ctl.db }))
vi.mock('#core/server/utils/migration-status', () => ({ migrationsReady: () => ctl.migrations!.promise }))
vi.mock('#core/server/utils/mail-host', () => ({ mailFakeState: ctl.fakeState, notifyMailAlert: async () => {} }))
vi.mock('#core/server/utils/site-url', () => ({ getSiteUrl: () => 'http://plugin.test' }))
vi.mock('#core/server/utils/db-connection', () => ({ createPgPool: () => ({ listen: async () => {}, end: async () => {} }) }))
vi.mock('croner', () => ({
  Cron: class {
    constructor(_pattern: string, _opts: unknown, fn: () => Promise<void>) {
      ctl.cron = fn
    }
  }
}))

const STATE = Symbol.for('nuxtinator.mail.state')

const BASE_ENV = {
  MAIL_TRANSPORT: 'provider',
  MAIL_FAKE_PROVIDER: '1',
  MAIL_PROVIDER: 'fake',
  MAIL_FAKE_API_KEY: 'plugin-key',
  MAIL_DOMAIN: 'plugin.example.test',
  SMTP_FROM: 'noreply@plugin.example.test',
  NUXT_SECRET_ENCRYPTION_KEY: SECRET,
  MAIL_OUTBOX_PUBLIC_KEY: '',
  MAIL_LISTEN_DATABASE_URL: '',
  MAIL_SWEEP_SECONDS: ''
}

let exit: ReturnType<typeof vi.spyOn>
let errors: ReturnType<typeof vi.spyOn>

function newMigrations() {
  let resolve!: (o: { database: boolean }) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<{ database: boolean }>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  ctl.migrations = { promise, resolve, reject }
}

async function loadPlugin(env: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(key, value)
  vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
  vi.stubGlobal('useRuntimeConfig', () => ({}))
  vi.resetModules()
  const utils = await import('../../server/utils/mail')
  const plugin = (await import('../../server/plugins/mail')).default as unknown as (app: unknown) => void
  const closeHooks: (() => Promise<void>)[] = []
  return {
    utils,
    closeHooks,
    run: () => plugin({ hooks: { hook: (_name: string, fn: () => Promise<void>) => closeHooks.push(fn) } })
  }
}

// Waits for the build to settle either way.
async function settled(utils: Awaited<ReturnType<typeof loadPlugin>>['utils']) {
  return await utils.useMail().then(mail => ({ mail, error: null }), (error: Error) => ({ mail: null, error }))
}

const tick = () => new Promise(r => setTimeout(r, 30))
const outbox = () => ctl.db.selectFrom('mail_outbox').selectAll().orderBy('created_at').execute()

beforeAll(async () => {
  await sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`).execute(ctl.db)
})

afterAll(async () => {
  await sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).execute(ctl.db)
  await ctl.db.destroy()
})

let migrated = false

// Stands in for the migrations plugin: the mail tables, in this file's schema.
async function migrate() {
  if (migrated) return
  const { up: up023 } = await import('../../migrations/023_create_mail_tables')
  const { up: up024 } = await import('../../migrations/024_create_mail_outbox')
  const { up: up025 } = await import('../../migrations/025_mail_suppression_function')
  await up023(ctl.db)
  await up024(ctl.db)
  await up025(ctl.db)
  migrated = true
}

beforeEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[STATE]
  newMigrations()
  ctl.cron = null
  ctl.fakeState.provider = null
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  if (migrated) await sql`TRUNCATE mail_outbox, mail_suppressions, mail_stream_routes, mail_domains, mail_accounts CASCADE`.execute(ctl.db)
})

afterEach(async () => {
  const mail = (globalThis as Record<symbol, { instance: { stop: () => Promise<void> } | null } | undefined>)[STATE]?.instance
  await mail?.stop()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the mail build', () => {
  it('waits for migrations, then syncs the env account; plugins that run later still register', async () => {
    const { utils, run } = await loadPlugin()
    run()
    // A plugin that runs after core's.
    utils.registerMailStream({ id: 'later', label: 'Later', defaultLocal: 'later', orgAssignable: false })
    await tick()
    expect(utils.mailIfBuilt()).toBeNull()

    await migrate()
    ctl.migrations!.resolve({ database: true })
    const { mail, error } = await settled(utils)
    expect(error).toBeNull()
    expect(mail!.streams.map(s => s.id)).toEqual(['account', 'system', 'later'])
    expect(await ctl.db.selectFrom('mail_domains').select(['domain', 'source']).execute())
      .toEqual([{ domain: 'plugin.example.test', source: 'env' }])
    expect(exit).not.toHaveBeenCalled()

    const fake = createFakeProvider('late')
    expect(() => utils.registerMailStream({ id: 'too-late', label: 'x', defaultLocal: 'x', orgAssignable: false })).toThrow(/after the mail kernel was built/)
    expect(() => utils.registerMailProvider(fake)).toThrow(/after the mail kernel was built/)
    expect(() => utils.registerSendGuard({ id: 'g', check: async () => ({ ok: true }) })).toThrow(/after the mail kernel was built/)
  })

  it('hands out the instance only once it is ready', async () => {
    const { utils } = await loadPlugin()
    const mail = utils.buildMail({ db: ctl.db, env: {}, secretKey: SECRET })
    expect(utils.mailIfBuilt()).toBeNull()
    utils.settleMail(mail)
    expect(utils.mailIfBuilt()).toBe(mail)
    expect(await utils.useMail()).toBe(mail)
  })

  it('a configuration that throws exits non-zero: an unknown MAIL_PROVIDER, a duplicate provider id', async () => {
    for (const setup of [
      async () => (await loadPlugin({ MAIL_PROVIDER: 'nope' })),
      async () => {
        const loaded = await loadPlugin()
        return { ...loaded, extra: () => loaded.utils.registerMailProvider(createFakeProvider('mailgun')) }
      }
    ]) {
      delete (globalThis as Record<symbol, unknown>)[STATE]
      exit.mockClear()
      newMigrations()
      const loaded = await setup() as Awaited<ReturnType<typeof loadPlugin>> & { extra?: () => void }
      loaded.run()
      loaded.extra?.()
      await migrate()
      ctl.migrations!.resolve({ database: true })
      const { error } = await settled(loaded.utils)
      expect(error).toBeTruthy()
      expect(exit).toHaveBeenCalledWith(1)
    }
  })

  it('never hangs, and stays up: no database, failed migrations, no key', async () => {
    const cases: [() => void, RegExp, Record<string, string>][] = [
      [() => ctl.migrations!.resolve({ database: false }), /not built/, {}],
      [() => ctl.migrations!.reject(new Error('migration 999 broke')), /migrations failed/, {}],
      [() => ctl.migrations!.resolve({ database: true }), /NUXT_SECRET_ENCRYPTION_KEY is not set/, { NUXT_SECRET_ENCRYPTION_KEY: '' }]
    ]
    for (const [settle, message, env] of cases) {
      delete (globalThis as Record<symbol, unknown>)[STATE]
      newMigrations()
      await migrate()
      const { utils, run } = await loadPlugin(env)
      run()
      settle()
      const { error } = await settled(utils)
      expect(error?.message).toMatch(message)
      await expect(utils.sendMail({ stream: 'system', to: 'a@x.test', subject: 's', html: '<p>h</p>' })).rejects.toThrow(message)
      expect(exit).not.toHaveBeenCalled()
    }
    expect(errors.mock.calls.some(c => String(c[0]).includes('NUXT_SECRET_ENCRYPTION_KEY'))).toBe(true)
  })

  it('with only MAIL_OUTBOX_PUBLIC_KEY, mail is queued for another process to send', async () => {
    await migrate()
    const { utils, run } = await loadPlugin({ NUXT_SECRET_ENCRYPTION_KEY: '', MAIL_OUTBOX_PUBLIC_KEY: outboxKeyPair(SECRET).publicKey })
    run()
    ctl.migrations!.resolve({ database: true })
    const { mail } = await settled(utils)
    expect(mail!.canSend).toBe(false)
    const fake = ctl.fakeState.provider!
    fake.control.deliver = false

    expect(await utils.sendMail({ stream: 'system', to: 'pk@x.test', subject: 's', html: '<p>h</p>' })).toMatchObject({ status: 'queued' })
    const { runTransaction } = await import('../../server/utils/after-commit')
    await runTransaction(ctl.db, tx => utils.enqueueMail(tx, { stream: 'account', to: 'pk2@x.test', subject: 's', html: '<p>h</p>' }))
    expect((await outbox()).map(r => r.status)).toEqual(['queued', 'queued'])
    expect(fake.sent).toHaveLength(0)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('enqueueMail', () => {
  it('makes its first attempt right after commit, and none after a rollback', async () => {
    await migrate()
    const { utils, run } = await loadPlugin()
    run()
    ctl.migrations!.resolve({ database: true })
    const { mail } = await settled(utils)
    // Joins the boot sweep, so it can't take the row before the flush does.
    await mail!.runOutboxSweep()
    const fake = ctl.fakeState.provider!
    fake.control.deliver = false
    const { runTransaction } = await import('../../server/utils/after-commit')

    let sentInside = -1
    await runTransaction(ctl.db, async (tx) => {
      await utils.enqueueMail(tx, { stream: 'system', to: 'commit@x.test', subject: 's', html: '<p>h</p>' })
      sentInside = fake.sent.length
    })
    expect(sentInside).toBe(0)
    expect(fake.sent.map(m => m.to)).toEqual(['commit@x.test'])
    expect((await outbox())[0]).toMatchObject({ status: 'sent', attempts: 1, message: null })

    await expect(runTransaction(ctl.db, async (tx) => {
      await utils.enqueueMail(tx, { stream: 'system', to: 'rollback@x.test', subject: 's', html: '<p>h</p>' })
      throw new Error('rolled back')
    })).rejects.toThrow('rolled back')
    await tick()
    expect(fake.sent.map(m => m.to)).toEqual(['commit@x.test'])
    expect(await outbox()).toHaveLength(1)
  })
})

describe('the nightly job', () => {
  it('purges the outbox even when the daily recheck throws', async () => {
    await migrate()
    const { utils, run } = await loadPlugin()
    run()
    ctl.migrations!.resolve({ database: true })
    const { mail } = await settled(utils)
    mail!.admin.runDailyJob = async () => {
      throw new Error('provider down')
    }
    const purge = vi.spyOn(mail!, 'purgeOutbox')
    await ctl.cron!()
    expect(purge).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.some(c => String(c[0]).includes('daily job failed'))).toBe(true)
  })
})
