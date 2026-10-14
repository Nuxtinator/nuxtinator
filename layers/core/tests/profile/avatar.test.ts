import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCoreTestData,
  createAndLoginUser
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
const SKIP_S3 = !process.env.S3_BUCKET_NAME || !process.env.S3_PUBLIC_BASE_URL

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
    const res = await $fetch<{ can_upload: boolean }>('/api/profile/avatar', auth)
    expect(typeof res.can_upload).toBe('boolean')
  })

  it('DELETE clears an avatar that points elsewhere', async () => {
    const { user, auth } = await createAndLoginUser(sql)
    await sql`UPDATE users SET avatar = 'https://example.com/photo.png' WHERE id = ${user.id}`

    const res = await $fetch('/api/profile/avatar', { method: 'DELETE', ...auth })
    expect(res.avatar).toBeNull()
    expect(await avatarOf(user.id)).toBe('')
  })

  it.skipIf(SKIP_S3)('rejects a non-image with 415', async () => {
    const { auth } = await createAndLoginUser(sql)
    const err = await $fetch('/api/profile/avatar', {
      method: 'POST',
      body: form(Buffer.from('plain text'), 'file.txt', 'text/plain'),
      ...auth
    }).catch(e => e)
    expect(err.statusCode).toBe(415)
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
