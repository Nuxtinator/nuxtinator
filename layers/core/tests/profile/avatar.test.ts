import { describe, it, expect, afterEach } from 'vitest'
import { $fetch, fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createAndLoginUser,
  publicStorageConfigured
} from '../helpers'

// 1x1 PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000d49444154789c63f8cf000000010100000118c4f3a90000000049454e44ae426082',
  'hex'
)

function form(file: Buffer, filename: string, type: string, field = 'file'): FormData {
  const fd = new FormData()
  fd.append(field, new Blob([new Uint8Array(file)], { type }), filename)
  return fd
}

// Uploads need a writable public bucket.
const SKIP_S3 = !publicStorageConfigured()

describe('/api/profile/avatar', () => {
  const sql = getHostAdminDb()

  afterEach(async () => {
    await cleanupCoreTestData(sql)
  })

  async function avatarOf(id: string): Promise<string> {
    return (await sql<{ avatar: string }[]>`SELECT avatar FROM users WHERE id = ${id}`)[0]!.avatar
  }

  it('requires sign-in', async () => {
    const err = await $fetch('/api/profile/avatar').catch(e => e)
    expect(err.statusCode).toBe(401)
  })

  it('says whether uploads are available', async () => {
    const { auth } = await createAndLoginUser(sql)
    const res = await $fetch<{ can_upload: boolean, max_mb: number, types: string[] }>('/api/profile/avatar', auth)
    expect(typeof res.can_upload).toBe('boolean')
    expect(res.max_mb).toBe(2)
    expect(res.types).toContain('image/png')
  })

  it('DELETE clears an avatar that points elsewhere', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    await sql`UPDATE users SET avatar = 'https://example.com/photo.png' WHERE id = ${user.id}`

    const res = await $fetch('/api/profile/avatar', { method: 'DELETE', ...auth })
    expect(res.avatar).toBeNull()
    expect(await avatarOf(user.id)).toBe('')
  })

  it.skipIf(SKIP_S3)('rejects bytes that are not an image with 415, whatever their declared type', async () => {
    const { auth } = await createAndLoginUser(sql)
    const err = await $fetch('/api/profile/avatar', {
      method: 'POST',
      body: form(Buffer.from('plain text'), 'file.png', 'image/png'),
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(415)
  })

  it.skipIf(SKIP_S3)('rejects an oversized body with 413', async () => {
    const { auth } = await createAndLoginUser(sql)
    const big = Buffer.concat([TINY_PNG, Buffer.alloc(3 * 1024 * 1024)])
    const err = await $fetch('/api/profile/avatar', {
      method: 'POST',
      body: form(big, 'big.png', 'image/png'),
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(413)
  })

  it.skipIf(SKIP_S3)('rejects a body without a "file" field with 400', async () => {
    const { auth } = await createAndLoginUser(sql)
    const err = await $fetch('/api/profile/avatar', {
      method: 'POST',
      body: form(TINY_PNG, 'a.png', 'image/png', 'other'),
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(400)
  })

  it.skipIf(SKIP_S3)('accepts an upload sent without a Content-Length', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    const encoded = new Response(form(TINY_PNG, 'a.png', 'image/png'))
    const bytes = new Uint8Array(await encoded.arrayBuffer())
    const res = await fetch('/api/profile/avatar', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': encoded.headers.get('content-type')! },
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }),
      duplex: 'half'
    } as RequestInit)
    expect(res.status).toBe(200)
    expect(await avatarOf(user.id)).toMatch(/\/avatars\/[0-9a-f]+\.png$/)
    await $fetch('/api/profile/avatar', { method: 'DELETE', ...auth })
  })

  it.skipIf(SKIP_S3)('uploads an image, stores its URL, and removes it', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    const res = await $fetch<{ avatar: string }>('/api/profile/avatar', {
      method: 'POST',
      body: form(TINY_PNG, 'a.png', 'image/png'),
      ...auth
    })
    expect(res.avatar).toMatch(/\/avatars\/[0-9a-f]+\.png$/)
    expect(await avatarOf(user.id)).toBe(res.avatar)

    await $fetch('/api/profile/avatar', { method: 'DELETE', ...auth })
    expect(await avatarOf(user.id)).toBe('')
  })
})
