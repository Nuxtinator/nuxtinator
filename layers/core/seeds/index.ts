import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql, type Kysely } from 'kysely'
import type { SeedContext } from './types'
import type { Database } from '../server/database/schema'

const HERE = dirname(fileURLToPath(import.meta.url))

// Demo accounts. All share the same dev password — these credentials live
// in cleartext in the repo on purpose: the seed is for local development
// only and exposing it makes onboarding zero-friction.
const DEV_PASSWORD = 'password123'

interface DemoUser {
  email: string
  displayName: string
  isAdmin: boolean
}

const DEMO_USERS: DemoUser[] = [
  { email: 'admin@example.com', displayName: 'Admin', isAdmin: true },
  { email: 'alice@example.com', displayName: 'Alice', isAdmin: false },
  { email: 'bob@example.com', displayName: 'Bob', isAdmin: false },
  { email: 'carol@example.com', displayName: 'Carol', isAdmin: false }
]

async function seedUsers(db: Kysely<Database>, log: SeedContext['log']): Promise<SeedContext['users']> {
  const hashed = await bcrypt.hash(DEV_PASSWORD, 12)
  const out: SeedContext['users'] = []

  for (const u of DEMO_USERS) {
    const existing = await db
      .selectFrom('users')
      .select(['id', 'is_admin'])
      .where(sql`lower(email)`, '=', u.email)
      .executeTakeFirst()

    if (existing) {
      // Re-run: don't clobber password / promote to is_admin if a human
      // changed it manually. Only ensure the operator admin stays admin.
      if (u.isAdmin && !existing.is_admin) {
        await db.updateTable('users')
          .set({ is_admin: true, verified: true })
          .where('id', '=', existing.id)
          .execute()
      }
      out.push({ id: existing.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin })
      log(`user (exists): ${u.email}`)
      continue
    }

    const id = randomUUID()
    const now = new Date().toISOString()
    await db.insertInto('users').values({
      id,
      created: now,
      updated: now,
      email: u.email,
      display_name: u.displayName,
      avatar: '',
      password: hashed,
      verified: true,
      roles: u.isAdmin ? ['admin'] : ['member'],
      is_admin: u.isAdmin,
      token_key: randomUUID(),
      token_expires_at: null,
      pending_email: null,
      email_change_token: null
    }).execute()
    out.push({ id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin })
    log(`user (new):    ${u.email}`)
  }

  return out
}

// Custom roles are org-scoped in multi-tenant mode (RLS + NOT NULL org_id).
// In single mode they're a flat global table. Seed only in single mode here;
// the tenancy seed plants the multi-mode equivalents per-org.
async function seedSingleModeCustomRoles(db: Kysely<Database>, log: SeedContext['log']): Promise<void> {
  const roles = [
    {
      name: 'Editor',
      description: 'Read + write across messages and apps.',
      permissions: ['messages.access', 'messages.read', 'messages.write']
    },
    {
      name: 'Viewer',
      description: 'Read-only across all apps.',
      permissions: ['messages.access', 'messages.read']
    }
  ]

  for (const r of roles) {
    const existing = await db
      .selectFrom('custom_roles')
      .select('id')
      .where('name', '=', r.name)
      .executeTakeFirst()
    if (existing) {
      log(`role (exists): ${r.name}`)
      continue
    }
    const now = new Date().toISOString()
    await db.insertInto('custom_roles').values({
      id: randomUUID(),
      created: now,
      updated: now,
      name: r.name,
      description: r.description,
      permissions: r.permissions
    }).execute()
    log(`role (new):    ${r.name}`)
  }
}

// "Enable all apps" — flip every entry in the apps catalog to `default`.
// Seed runs out-of-band from Nitro, so the per-app `registerApp()` calls
// haven't fired and the table may be empty (or stale) on first run. Walk
// the layers/apps/* directory directly to discover which app layers exist
// in this deploy, then upsert each row with status='default'.
async function seedAppsCatalog(db: Kysely<Database>, log: SeedContext['log']): Promise<void> {
  const appsRoot = resolve(HERE, '../../apps')
  if (!existsSync(appsRoot)) {
    log('apps catalog: no apps/ dir, skipping')
    return
  }
  const ids = readdirSync(appsRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    // Filter to real app layers — directories with a nuxt.config.ts. Skips
    // half-finished placeholders that don't register a Nitro plugin.
    .filter(name => existsSync(resolve(appsRoot, name, 'nuxt.config.ts')))

  for (const id of ids) {
    await db.insertInto('apps')
      .values({ id, status: 'default' })
      .onConflict(oc => oc.column('id').doUpdateSet({ status: 'default', updated_at: new Date().toISOString() }))
      .execute()
    log(`app:           ${id} -> default`)
  }
}

export default async function seed(ctx: SeedContext): Promise<void> {
  const db = ctx.db as Kysely<Database>

  ctx.users = await seedUsers(db, ctx.log)

  if (!ctx.tenancyEnabled) {
    await seedSingleModeCustomRoles(db, ctx.log)
  }

  await seedAppsCatalog(db, ctx.log)
}
