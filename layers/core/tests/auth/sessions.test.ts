import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import jwt from 'jsonwebtoken'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createTestUser,
  createTestSession
} from '../helpers'

const NATIVE = { 'x-auth-client': 'native' }

function cookieValue(setCookie: string, name: string): string | null {
  const m = setCookie.match(new RegExp(`${name}=([^;]*)`))
  return m && m[1] ? m[1] : null
}

async function nativeLogin(email: string, password: string) {
  return await $fetch<{ accessToken: string, refreshToken: string, expiresIn: number }>('/api/auth/login', {
    method: 'POST',
    headers: NATIVE,
    body: { email, password }
  })
}

describe('sessions', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  it('browser login sets access + refresh cookies and records a web session', async () => {
    const user = await createTestUser(sql, { password: 'pw' })
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'pw' })
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accessToken).toBeUndefined()

    const setCookie = res.headers.get('set-cookie') || ''
    expect(cookieValue(setCookie, 'auth-token')).toBeTruthy()
    expect(cookieValue(setCookie, 'auth-refresh')).toBeTruthy()

    const rows = await sql<{ client: string }[]>`SELECT client FROM sessions WHERE user_id = ${user.id}`
    expect(rows.map(r => r.client)).toEqual(['web'])
  })

  it('native login returns tokens in the body and the bearer token authenticates', async () => {
    const user = await createTestUser(sql, { password: 'pw' })
    const tokens = await nativeLogin(user.email, 'pw')
    expect(tokens.accessToken).toBeTruthy()
    expect(tokens.refreshToken).toBeTruthy()

    const me = await $fetch('/api/auth/me', { headers: { authorization: `Bearer ${tokens.accessToken}` } })
    expect(me.user.id).toBe(user.id)
  })

  it('rejects an access token that has no session id', async () => {
    const user = await createTestUser(sql)
    const legacy = jwt.sign({ userId: user.id, email: user.email, display_name: user.display_name }, process.env.JWT_SECRET!, { expiresIn: '1d' })
    const err = await $fetch('/api/auth/me', { headers: { cookie: `auth-token=${legacy}` } }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('native refresh rotates the token; the old one works only inside the grace window', async () => {
    const user = await createTestUser(sql, { password: 'pw' })
    const first = await nativeLogin(user.email, 'pw')

    const second = await $fetch<{ accessToken: string, refreshToken: string | null }>('/api/auth/refresh', {
      method: 'POST', headers: NATIVE, body: { refreshToken: first.refreshToken }
    })
    expect(second.accessToken).toBeTruthy()
    expect(second.refreshToken).toBeTruthy()
    expect(second.refreshToken).not.toBe(first.refreshToken)

    // A request that raced the rotation still gets an access token.
    const racer = await $fetch<{ accessToken: string, refreshToken: string | null }>('/api/auth/refresh', {
      method: 'POST', headers: NATIVE, body: { refreshToken: first.refreshToken }
    })
    expect(racer.accessToken).toBeTruthy()
    expect(racer.refreshToken).toBeNull()

    // Replaying the rotated-out token after the grace window revokes the session.
    await sql`UPDATE sessions SET rotated_at = now() - interval '10 minutes' WHERE user_id = ${user.id}`
    const err = await $fetch('/api/auth/refresh', {
      method: 'POST', headers: NATIVE, body: { refreshToken: first.refreshToken }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
    const rows = await sql`SELECT 1 FROM sessions WHERE user_id = ${user.id}`
    expect(rows.length).toBe(0)
  })

  it('a browser request with only a refresh cookie is refreshed transparently', async () => {
    const user = await createTestUser(sql, { password: 'pw' })
    const login = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'pw' })
    })
    const refresh = cookieValue(login.headers.get('set-cookie') || '', 'auth-refresh')!

    const res = await fetch('/api/auth/me', { headers: { cookie: `auth-refresh=${refresh}` } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe(user.id)

    const setCookie = res.headers.get('set-cookie') || ''
    expect(cookieValue(setCookie, 'auth-token')).toBeTruthy()
    expect(cookieValue(setCookie, 'auth-refresh')).not.toBe(refresh)
  })

  it('logout deletes the session so its refresh token stops working', async () => {
    const user = await createTestUser(sql, { password: 'pw' })
    const tokens = await nativeLogin(user.email, 'pw')

    await $fetch('/api/auth/logout', {
      method: 'POST',
      headers: { ...NATIVE, authorization: `Bearer ${tokens.accessToken}` },
      body: { refreshToken: tokens.refreshToken }
    })

    const err = await $fetch('/api/auth/refresh', {
      method: 'POST', headers: NATIVE, body: { refreshToken: tokens.refreshToken }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('lists sessions and signs out the other devices', async () => {
    const user = await createTestUser(sql)
    const current = await createTestSession(sql, user)
    await createTestSession(sql, user)

    const list = await $fetch<{ sessions: Array<{ id: string, current: boolean }> }>('/api/auth/sessions', current.auth)
    expect(list.sessions.length).toBe(2)
    expect(list.sessions.find(s => s.current)?.id).toBe(current.sessionId)

    await $fetch('/api/auth/sessions', { method: 'DELETE', ...current.auth })
    const rows = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${user.id}`
    expect(rows.map(r => r.id)).toEqual([current.sessionId])
  })
})
