#!/usr/bin/env bun

// One-shot bootstrap: create (or promote) an operator admin user.
//
// Operator admin = `users.is_admin = true`. In single-tenant mode this is
// the only operator gate. In multi-tenant mode it's the cross-org admin —
// gates `/admin/*` host endpoints. Membership in any specific org is still
// required for org-scoped reach (the host admin is not a magic super-user
// inside individual orgs, just for cross-org operations).
//
// Idempotent: re-running with the same email promotes the existing user;
// re-running with a new email creates a second admin.
//
//   bun run scripts/bootstrap-admin.ts

import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { sql } from 'kysely'
import { createKyselyDb } from '../server/utils/db-connection'
import { normalizeEmail } from '../server/utils/email-address'
import type { Database } from '../server/database/schema'

async function prompt(rl: ReturnType<typeof createInterface>, q: string, opts: { hidden?: boolean } = {}) {
  if (!opts.hidden) return (await rl.question(q)).trim()
  process.stdout.write(q)
  const stdin = process.stdin
  stdin.resume()
  // @ts-expect-error tty-only API
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
  let buf = ''
  return await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8')
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          // @ts-expect-error tty-only API
          if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '') process.exit(130)
        if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1)
        } else {
          buf += ch
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
  }
  const db = createKyselyDb<Database>(url, { max: 2 })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const email = normalizeEmail(await prompt(rl, 'Email: '))
    if (!email || !email.includes('@')) {
      console.error('Invalid email')
      process.exit(1)
    }
    const display_name = await prompt(rl, 'Display name: ')
    if (display_name.length < 2) {
      console.error('Display name must be at least 2 characters')
      process.exit(1)
    }
    const password = await prompt(rl, 'Password: ', { hidden: true })
    if (password.length < 8) {
      console.error('Password must be at least 8 characters')
      process.exit(1)
    }
    rl.close()

    const existing = await db
      .selectFrom('users')
      .select(['id', 'is_admin'])
      .where(sql`lower(email)`, '=', email)
      .executeTakeFirst()

    if (existing) {
      if (existing.is_admin) {
        console.log(`User ${email} is already an operator admin (id=${existing.id})`)
        return
      }
      await db
        .updateTable('users')
        .set({ is_admin: true, verified: true })
        .where('id', '=', existing.id)
        .execute()
      console.log(`Promoted existing user ${email} to operator admin (id=${existing.id})`)
      return
    }

    const hashed = await bcrypt.hash(password, 12)
    const userId = randomUUID()
    const tokenKey = randomUUID()
    const now = new Date().toISOString()

    await db
      .insertInto('users')
      .values({
        id: userId,
        created: now,
        updated: now,
        email,
        display_name,
        avatar: '',
        password: hashed,
        verified: true,
        roles: ['admin'],
        is_admin: true,
        token_key: tokenKey,
        token_expires_at: null
      })
      .execute()

    console.log(`Created operator admin ${email} (id=${userId})`)
  } finally {
    await db.destroy().catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
