// Widget sign-in: a session-approved authorize + PKCE token exchange yields a
// bearer token that only works for the project it was issued for.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import { createHash, randomBytes } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupFeedbackTestData,
  createFeedbackOrgWith,
  getAuthHeaders,
  generateScopedTestToken,
  createTestProject
} from '../helpers'

const REDIRECT = 'http://localhost:9999/cb'

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

describe('widget sign-in', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupFeedbackTestData(sql)
  })

  async function signIn(auth: ReturnType<typeof getAuthHeaders>, projectId: string): Promise<string> {
    const { verifier, challenge } = pkce()
    const { code } = await $fetch<{ code: string }>('/api/v1/feedback/authorize', {
      method: 'POST',
      body: { project_id: projectId, redirect_uri: REDIRECT, code_challenge: challenge },
      ...auth
    })
    const { token } = await $fetch<{ token: string }>('/api/v1/feedback/token', {
      method: 'POST',
      body: { code, code_verifier: verifier }
    })
    return token
  }

  it('issues a token that works only for its own project', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const a = await createTestProject(sql, { org_id: org.id })
    const b = await createTestProject(sql, { org_id: org.id })
    const token = await signIn(getAuthHeaders(user), a.id)
    const bearer = { headers: { Authorization: `Bearer ${token}` } }

    await $fetch(`/api/v1/feedback?project_id=${a.id}`, bearer)
    const me = await $fetch<{ user: { id: string } }>(`/api/v1/feedback/me?project_id=${a.id}`, bearer)
    expect(me.user.id).toBe(user.id)

    const otherRead = await $fetch(`/api/v1/feedback?project_id=${b.id}`, bearer).catch(e => e)
    expect(otherRead.statusCode).toBe(401)
    const otherMe = await $fetch(`/api/v1/feedback/me?project_id=${b.id}`, bearer).catch(e => e)
    expect(otherMe.statusCode).toBe(401)

    // On another project the token doesn't identify the submitter.
    const anon = await $fetch('/api/v1/feedback', {
      method: 'POST',
      body: { project_id: b.id, problem_description: 'pd', suggested_fix: 'sf' },
      ...bearer
    }).catch(e => e)
    expect(anon.statusCode).toBe(400)
  })

  it('rejects tokens with no project binding', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const unbound = generateScopedTestToken(user, 'feedback')
    const err = await $fetch(`/api/v1/feedback?project_id=${project.id}`, {
      headers: { Authorization: `Bearer ${unbound}` }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('authorize needs a host session, not a widget token', async () => {
    const { org, user } = await createFeedbackOrgWith(sql, ['admin'])
    const project = await createTestProject(sql, { org_id: org.id })
    const widgetToken = generateScopedTestToken(user, 'feedback', { project_id: project.id })
    const err = await $fetch('/api/v1/feedback/authorize', {
      method: 'POST',
      body: { project_id: project.id, redirect_uri: REDIRECT, code_challenge: pkce().challenge },
      headers: { Authorization: `Bearer ${widgetToken}` }
    }).catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('the approval page cannot be framed', async () => {
    const res = await fetch('/feedback/connect')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'')
  })
})
