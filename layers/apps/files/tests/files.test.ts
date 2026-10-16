import { randomUUID } from 'node:crypto'
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupFilesTestData,
  createFilesOrgWith,
  createTestDoc,
  createTestFile,
  createTestSite,
  withOrgHeader
} from './helpers'

const sql = getHostAdminDb()

describe('files layer', () => {
  afterEach(async () => { await cleanupFilesTestData(sql) })

  it('creates a document with an initial version', async () => {
    const { org, auth } = await createFilesOrgWith(sql)
    const res = await $fetch<{ item: { id: string, kind: string, title: string } }>(
      '/api/files/items',
      { method: 'POST', body: { title: 'My Doc', body_md: '# Hi' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.item.id).toBeDefined()
    expect(res.item.kind).toBe('doc')

    const versions = await sql`SELECT id FROM files_versions WHERE item_id = ${res.item.id}`
    expect(versions.length).toBe(1)
  })

  it('lists items and fetches one with body', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id, title: 'Listed', body_md: 'body here' })

    const list = await $fetch<{ items: Array<{ id: string }> }>(
      '/api/files/items', { ...withOrgHeader(auth, org.slug) }
    )
    expect(list.items.some(i => i.id === id)).toBe(true)

    const one = await $fetch<{ item: { body_md: string } }>(
      `/api/files/items/${id}`, { ...withOrgHeader(auth, org.slug) }
    )
    expect(one.item.body_md).toBe('body here')
  })

  it('editing a doc creates a new version snapshot', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id, body_md: 'v1' })

    await $fetch(`/api/files/items/${id}`, {
      method: 'PATCH', body: { body_md: 'v2 edited' }, ...withOrgHeader(auth, org.slug)
    })

    const versions = await $fetch<{ versions: Array<{ content: string }> }>(
      `/api/files/items/${id}/versions`, { ...withOrgHeader(auth, org.slug) }
    )
    // initial seed version + the edit
    expect(versions.versions.length).toBe(2)
    expect(versions.versions[0]!.content).toBe('v2 edited')
  })

  it('restores a past version as a new head version', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id, body_md: 'original' })
    await $fetch(`/api/files/items/${id}`, {
      method: 'PATCH', body: { body_md: 'changed' }, ...withOrgHeader(auth, org.slug)
    })

    const before = await $fetch<{ versions: Array<{ id: string, content: string }> }>(
      `/api/files/items/${id}/versions`, { ...withOrgHeader(auth, org.slug) }
    )
    const original = before.versions.find(v => v.content === 'original')!

    await $fetch(`/api/files/items/${id}/versions/${original.id}/restore`, {
      method: 'POST', ...withOrgHeader(auth, org.slug)
    })

    const item = await $fetch<{ item: { body_md: string } }>(
      `/api/files/items/${id}`, { ...withOrgHeader(auth, org.slug) }
    )
    expect(item.item.body_md).toBe('original')
  })

  it('issues, then revokes, a public share link', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id })

    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )
    expect(issued.share_token).toMatch(/^[0-9a-f-]{36}$/)

    await $fetch(`/api/files/items/${id}/share`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })
    const row = await sql`SELECT share_token FROM files_items WHERE id = ${id}`
    expect(row[0]!.share_token).toBeNull()
  })

  it('serves a doc via the public link with no auth, and 404s after revoke', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id, title: 'Public Doc', body_md: 'public body' })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )

    // No auth headers at all.
    const pub = await $fetch<{ kind: string, title: string, body_md: string }>(
      `/api/files/public/${issued.share_token}`
    )
    expect(pub.kind).toBe('doc')
    expect(pub.body_md).toBe('public body')

    await $fetch(`/api/files/items/${id}/share`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })
    const res = await fetch(`/api/files/public/${issued.share_token}`)
    expect(res.status).toBe(404)
  })

  it('public link returns a signed url for a file', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestFile(sql, { org_id: org.id, created_by: user.id, filename: 'pic.png', mime: 'image/png' })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )
    const pub = await $fetch<{ kind: string, url: string | null, mime: string }>(
      `/api/files/public/${issued.share_token}`
    )
    expect(pub.kind).toBe('file')
    expect(pub.mime).toBe('image/png')
    expect(pub.url).toBeTruthy()
  })

  it('soft-deletes an item (subsequent GET 404s)', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id })

    await $fetch(`/api/files/items/${id}`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })
    const res = await fetch(`/api/files/items/${id}`, { ...withOrgHeader(auth, org.slug) })
    expect(res.status).toBe(404)
  })

  it('full-text search finds a doc by body', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    await createTestDoc(sql, { org_id: org.id, created_by: user.id, title: 'Findable', body_md: 'a rare quetzal appears' })

    const res = await $fetch<{ items: Array<{ title: string }> }>(
      '/api/files/search', { query: { q: 'quetzal' }, ...withOrgHeader(auth, org.slug) }
    )
    expect(res.items.some(i => i.title === 'Findable')).toBe(true)
  })

  it('isolates items across orgs (RLS)', async () => {
    const a = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: a.org.id, created_by: a.user.id })

    const b = await createFilesOrgWith(sql)
    // B's admin, scoped to B's org, must not see A's item.
    const list = await $fetch<{ items: Array<{ id: string }> }>(
      '/api/files/items', { ...withOrgHeader(b.auth, b.org.slug) }
    )
    expect(list.items.some(i => i.id === id)).toBe(false)

    const res = await fetch(`/api/files/items/${id}`, { ...withOrgHeader(b.auth, b.org.slug) })
    expect(res.status).toBe(404)
  })

  it('rejects an upload with no file part (400)', async () => {
    const { org, auth } = await createFilesOrgWith(sql)
    const res = await fetch('/api/files/uploads', { method: 'POST', ...withOrgHeader(auth, org.slug) })
    expect(res.status).toBe(400)
  })

  it('returns 404 (not 500) for a non-UUID item id', async () => {
    const { org, auth } = await createFilesOrgWith(sql)
    const res = await fetch('/api/files/items/not-a-uuid', { ...withOrgHeader(auth, org.slug) })
    expect(res.status).toBe(404)
  })

  it('public route 404s on a malformed token (no auth)', async () => {
    const res = await fetch('/api/files/public/not-a-uuid')
    expect(res.status).toBe(404)
  })

  it('creates a site with an initial version', async () => {
    const { org, auth } = await createFilesOrgWith(sql)
    const res = await $fetch<{ item: { id: string, kind: string } }>(
      '/api/files/items',
      {
        method: 'POST',
        body: { kind: 'site', title: 'My Site', body_md: '<h1>hello</h1>' },
        ...withOrgHeader(auth, org.slug)
      }
    )
    expect(res.item.kind).toBe('site')

    const versions = await sql`SELECT id FROM files_versions WHERE item_id = ${res.item.id}`
    expect(versions.length).toBe(1)
  })

  it('rejects an unknown item kind (400)', async () => {
    const { org, auth } = await createFilesOrgWith(sql)
    const res = await fetch('/api/files/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withOrgHeader(auth, org.slug).headers },
      body: JSON.stringify({ kind: 'widget', title: 'Nope' })
    })
    expect(res.status).toBe(400)
  })

  it('editing a site creates a new version snapshot', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, html: '<p>v1</p>' })

    await $fetch(`/api/files/items/${id}`, {
      method: 'PATCH', body: { body_md: '<p>v2</p>' }, ...withOrgHeader(auth, org.slug)
    })

    const versions = await $fetch<{ versions: Array<{ content: string }> }>(
      `/api/files/items/${id}/versions`, { ...withOrgHeader(auth, org.slug) }
    )
    expect(versions.versions.length).toBe(2)
    expect(versions.versions[0]!.content).toBe('<p>v2</p>')
  })

  it('serves a shared site raw with the sandbox CSP, and 404s after revoke', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const html = '<!doctype html><html><body><h1>It works</h1></body></html>'
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, html })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )

    // No auth headers at all.
    const res = await fetch(`/files/site/${issued.share_token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    // Opaque origin: the page must never be able to ride a visitor's cookie.
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(res.headers.get('content-security-policy')).toContain('allow-downloads')
    expect(res.headers.get('content-security-policy')).toContain('allow-popups-to-escape-sandbox')
    expect(await res.text()).toBe(html)

    await $fetch(`/api/files/items/${id}/share`, { method: 'DELETE', ...withOrgHeader(auth, org.slug) })
    const after = await fetch(`/files/site/${issued.share_token}`)
    expect(after.status).toBe(404)
  })

  it('sends a signed-in visitor to the framed site page; ?bare=1 serves the HTML', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const html = '<!doctype html><html><body><h1>Framed</h1></body></html>'
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, html })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )

    const redirected = await fetch(`/files/site/${issued.share_token}`, { ...auth, redirect: 'manual' })
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBe(`/files/public/${issued.share_token}`)

    const bare = await fetch(`/files/site/${issued.share_token}?bare=1`, { ...auth, redirect: 'manual' })
    expect(bare.status).toBe(200)
    expect(bare.headers.get('content-security-policy')).toContain('sandbox')
    expect(await bare.text()).toBe(html)
  })

  it('site raw route 404s for a doc share token', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )

    const res = await fetch(`/files/site/${issued.share_token}`)
    expect(res.status).toBe(404)
  })

  it('public token API identifies a site without returning its body', async () => {
    const { org, user, auth } = await createFilesOrgWith(sql)
    const { id } = await createTestSite(sql, { org_id: org.id, created_by: user.id, title: 'Landing' })
    const issued = await $fetch<{ share_token: string }>(
      `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
    )

    const pub = await $fetch<{ kind: string, title: string, body_md?: string }>(
      `/api/files/public/${issued.share_token}`
    )
    expect(pub.kind).toBe('site')
    expect(pub.title).toBe('Landing')
    expect(pub.body_md).toBeUndefined()
  })

  describe('raw file route', () => {
    async function sharedFile(filename = 'clip.mp4', mime = 'video/mp4') {
      const ctx = await createFilesOrgWith(sql)
      const { id } = await createTestFile(sql, { org_id: ctx.org.id, created_by: ctx.user.id, filename, mime })
      const issued = await $fetch<{ share_token: string }>(
        `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(ctx.auth, ctx.org.slug) }
      )
      return { ...ctx, id, token: issued.share_token }
    }

    function rawStatus(path: string): Promise<number> {
      return fetch(path, { redirect: 'manual' }).then(r => r.status)
    }

    it('redirects a shared file to a signed inline bucket URL, uncached', async () => {
      const { token } = await sharedFile()
      const res = await fetch(`/files/raw/${token}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const location = new URL(res.headers.get('location')!)
      expect(location.host).toBe(new URL(process.env.S3_ENDPOINT!).host)
      expect(location.searchParams.get('response-content-disposition')).toBe('inline; filename="clip.mp4"')
      expect(location.searchParams.get('response-content-type')).toBe('video/mp4')
    })

    it('?download=1 signs an attachment disposition with a UTF-8 name', async () => {
      const { token } = await sharedFile('résumé.pdf', 'application/pdf')
      const res = await fetch(`/files/raw/${token}?download=1`, { redirect: 'manual' })
      const location = new URL(res.headers.get('location')!)
      expect(location.searchParams.get('response-content-disposition'))
        .toBe('attachment; filename="r_sum_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf')
    })

    it('answers HEAD', async () => {
      const { token } = await sharedFile()
      const res = await fetch(`/files/raw/${token}`, { method: 'HEAD', redirect: 'manual' })
      expect(res.status).toBe(302)
    })

    it('404s for unknown, malformed, revoked, reissued, and deleted tokens', async () => {
      expect(await rawStatus(`/files/raw/${randomUUID()}`)).toBe(404)
      expect(await rawStatus('/files/raw/not-a-uuid')).toBe(404)

      const revoked = await sharedFile()
      await $fetch(`/api/files/items/${revoked.id}/share`, { method: 'DELETE', ...withOrgHeader(revoked.auth, revoked.org.slug) })
      expect(await rawStatus(`/files/raw/${revoked.token}`)).toBe(404)

      const reissued = await sharedFile()
      await $fetch(`/api/files/items/${reissued.id}/share`, { method: 'POST', ...withOrgHeader(reissued.auth, reissued.org.slug) })
      expect(await rawStatus(`/files/raw/${reissued.token}`)).toBe(404)

      const deleted = await sharedFile()
      await $fetch(`/api/files/items/${deleted.id}`, { method: 'DELETE', ...withOrgHeader(deleted.auth, deleted.org.slug) })
      expect(await rawStatus(`/files/raw/${deleted.token}`)).toBe(404)
    })

    it('404s for doc and site tokens', async () => {
      const { org, user, auth } = await createFilesOrgWith(sql)
      const doc = await createTestDoc(sql, { org_id: org.id, created_by: user.id })
      const site = await createTestSite(sql, { org_id: org.id, created_by: user.id })
      for (const { id } of [doc, site]) {
        const issued = await $fetch<{ share_token: string }>(
          `/api/files/items/${id}/share`, { method: 'POST', ...withOrgHeader(auth, org.slug) }
        )
        expect(await rawStatus(`/files/raw/${issued.share_token}`)).toBe(404)
      }
    })
  })

  it('nulls created_by when the creator is deleted (item survives)', async () => {
    const { org, user } = await createFilesOrgWith(sql)
    const { id } = await createTestDoc(sql, { org_id: org.id, created_by: user.id })

    // Must not throw (the old NOT NULL + SET NULL combo aborted this).
    await sql`DELETE FROM users WHERE id = ${user.id}`

    const rows = await sql`SELECT created_by FROM files_items WHERE id = ${id}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.created_by).toBeNull()
  })
})
