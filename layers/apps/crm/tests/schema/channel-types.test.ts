// Admin-created channel types: the merged catalog, delete semantics (code
// types 400, claimed addresses 409), and the end-to-end path for an
// admin-created communication_channel field on top of a custom channel type.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  withOrgHeader
} from '../helpers'

interface ChannelTypeSummary {
  key: string
  label: string
  icon: string | null
  valueFormat: string
  custom: boolean
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

type Opts = ReturnType<typeof withOrgHeader>

async function createChannelType(opts: Opts, body: Record<string, unknown>) {
  return await $fetch<{ channelType: ChannelTypeSummary }>('/api/crm/schema/channel-types', {
    method: 'POST',
    body,
    ...opts
  })
}

describe('channel-type catalog', () => {
  it('merges code-registered and admin-created types', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await createChannelType(opts, { typeKey: 'whatsapp', label: 'WhatsApp', valueFormat: 'phone' })
    const res = await $fetch<{ canManage: boolean, channelTypes: ChannelTypeSummary[] }>(
      '/api/crm/schema/channel-types', opts
    )
    expect(res.canManage).toBe(true)
    const byKey = new Map(res.channelTypes.map(t => [t.key, t]))
    expect(byKey.get('email')).toMatchObject({ custom: false, valueFormat: 'email' })
    expect(byKey.get('whatsapp')).toMatchObject({ custom: true, valueFormat: 'phone', label: 'WhatsApp' })
  })

  it('409s on key collisions with code-registered and existing custom types', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const codeCollision = await createChannelType(
      opts, { typeKey: 'email', label: 'Email 2', valueFormat: 'email' }
    ).catch(e => e)
    expect(codeCollision.statusCode).toBe(409)

    await createChannelType(opts, { typeKey: 'signal', label: 'Signal', valueFormat: 'phone' })
    const customCollision = await createChannelType(
      opts, { typeKey: 'signal', label: 'Signal 2', valueFormat: 'phone' }
    ).catch(e => e)
    expect(customCollision.statusCode).toBe(409)
  })
})

describe('DELETE /api/crm/schema/channel-types/:key', () => {
  it('deletes an unused custom channel type', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    await createChannelType(opts, { typeKey: 'telegram', label: 'Telegram', valueFormat: 'handle' })

    await $fetch('/api/crm/schema/channel-types/telegram', { method: 'DELETE', ...opts })
    const res = await $fetch<{ channelTypes: ChannelTypeSummary[] }>('/api/crm/schema/channel-types', opts)
    expect(res.channelTypes.find(t => t.key === 'telegram')).toBeUndefined()
  })

  it('400s for code-registered types and 404s for unknown keys', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const code = await $fetch('/api/crm/schema/channel-types/email', { method: 'DELETE', ...opts }).catch(e => e)
    expect(code.statusCode).toBe(400)

    const unknown = await $fetch('/api/crm/schema/channel-types/nonsense', { method: 'DELETE', ...opts }).catch(e => e)
    expect(unknown.statusCode).toBe(404)
  })
})

describe('admin communication_channel fields', () => {
  it('custom channel type + custom channel field work end-to-end on a record', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await createChannelType(opts, { typeKey: 'whatsapp', label: 'WhatsApp', valueFormat: 'phone' })
    const field = await $fetch<{ field: { key: string, kind: string, channelType: string | null, custom: boolean } }>(
      '/api/records/schema/types/contacts/fields',
      {
        method: 'POST',
        body: { fieldKey: 'whatsapp', kind: 'communication_channel', label: 'WhatsApp', channelType: 'whatsapp' },
        ...opts
      }
    )
    expect(field.field).toMatchObject({ kind: 'communication_channel', channelType: 'whatsapp', custom: true })

    const rec = await $fetch<{ id: string }>('/api/records/entries/contacts', {
      method: 'POST',
      body: { fields: { name: 'test-crm WhatsApper' } },
      ...opts
    })
    const added = await $fetch<{ entries: Array<{ channelId: string, channelType: string, value: string }> }>(
      `/api/crm/records/contacts/${rec.id}/channels`,
      {
        method: 'POST',
        body: { channelTypeKey: 'whatsapp', fieldKey: 'whatsapp', value: '+1 (555) 010-9999' },
        ...opts
      }
    )
    expect(added.entries).toHaveLength(1)
    expect(added.entries[0]!.channelType).toBe('whatsapp')

    // Hydration surfaces the custom channel field like a manifest one.
    const detail = await $fetch<{ fields: Record<string, unknown> }>(
      `/api/records/entries/contacts/${rec.id}`, opts
    )
    expect(detail.fields.whatsapp).toEqual([
      expect.objectContaining({ channelType: 'whatsapp', value: '+1 (555) 010-9999' })
    ])

    const rows = await sql`
      SELECT normalized_value FROM crm_channels WHERE id = ${added.entries[0]!.channelId}
    `
    expect(rows[0]!.normalized_value).toBe('+15550109999')

    // The channel type now has claimed addresses — deleting it must 409.
    const blocked = await $fetch('/api/crm/schema/channel-types/whatsapp', { method: 'DELETE', ...opts }).catch(e => e)
    expect(blocked.statusCode).toBe(409)
  })

  it('requires a channelType that exists in the merged catalog', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const missing = await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'chan_a', kind: 'communication_channel', label: 'Chan A' },
      ...opts
    }).catch(e => e)
    expect(missing.statusCode).toBe(400)

    const unknown = await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'chan_b', kind: 'communication_channel', label: 'Chan B', channelType: 'nonsense' },
      ...opts
    }).catch(e => e)
    expect(unknown.statusCode).toBe(400)

    const wrongKind = await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'chan_c', kind: 'text', label: 'Chan C', channelType: 'email' },
      ...opts
    }).catch(e => e)
    expect(wrongKind.statusCode).toBe(400)
  })
})
