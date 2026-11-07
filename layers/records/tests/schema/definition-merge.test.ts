// The merged definition readers, exercised through the schema routes:
// code manifests ⊳ DB override rows, admin-created customs as orphan rows
// with kind/is_custom, stale orphans surfaced only to schema managers, and
// the persisted-state rule (override rows never store default-equal values).
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  addRecordsMember,
  withOrgHeader
} from '../helpers'

interface FieldEntry {
  key: string
  kind: string
  label: string
  icon: string | null
  section: string | null
  required: boolean
  hidden: boolean
  order: number
  options: Record<string, { label: string }> | null
  custom: boolean
  orphan: boolean
  channelType: string | null
  column: string | null
}

interface FieldsResponse {
  sections: Record<string, { label: string, order?: number }>
  statusField: string | null
  fields: FieldEntry[]
}

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

describe('GET /api/records/schema/types/:type/fields (contacts manifest)', () => {
  it('serves the code manifest with promoted columns and channel types', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const res = await $fetch<FieldsResponse>(
      '/api/records/schema/types/contacts/fields',
      { ...withOrgHeader(auth, org.slug) }
    )
    const byKey = new Map(res.fields.map(f => [f.key, f]))
    expect(byKey.get('name')).toMatchObject({ column: 'name', required: true, custom: false, orphan: false })
    expect(byKey.get('status')).toMatchObject({ column: 'status', kind: 'key_select' })
    expect(Object.keys(byKey.get('status')!.options ?? {})).toContain('active')
    expect(byKey.get('contact_email')).toMatchObject({ kind: 'communication_channel', channelType: 'email' })
    expect(res.statusField).toBe('status')
    expect(res.sections.details?.label).toBe('Details')
  })
})

describe('field label overrides (code-owned defaults contract)', () => {
  it('stores an override, reverts on null, and never persists default-equal values', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    // Override.
    const patched = await $fetch<{ field: FieldEntry }>(
      '/api/records/schema/types/contacts/fields/nickname',
      { method: 'PATCH', body: { label: 'Alias' }, ...opts }
    )
    expect(patched.field.label).toBe('Alias')
    expect(patched.field.custom).toBe(false)

    let rows = await sql`
      SELECT label_override FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'nickname'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label_override).toBe('Alias')

    // Setting the label back to the code default deletes the row outright.
    await $fetch(
      '/api/records/schema/types/contacts/fields/nickname',
      { method: 'PATCH', body: { label: 'Nickname' }, ...opts }
    )
    rows = await sql`
      SELECT id FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'nickname'
    `
    expect(rows).toHaveLength(0)

    const res = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    expect(res.fields.find(f => f.key === 'nickname')!.label).toBe('Nickname')
  })
})

describe('field icon overrides', () => {
  it('stores an icon override on a manifest field and reverts on null', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const patched = await $fetch<{ field: FieldEntry }>(
      '/api/records/schema/types/contacts/fields/nickname',
      { method: 'PATCH', body: { icon: 'i-lucide-star' }, ...opts }
    )
    expect(patched.field.icon).toBe('i-lucide-star')

    let rows = await sql`
      SELECT icon_override FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'nickname'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.icon_override).toBe('i-lucide-star')

    // Reverting the only override deletes the row outright.
    await $fetch(
      '/api/records/schema/types/contacts/fields/nickname',
      { method: 'PATCH', body: { icon: null }, ...opts }
    )
    rows = await sql`
      SELECT id FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'nickname'
    `
    expect(rows).toHaveLength(0)

    const res = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    expect(res.fields.find(f => f.key === 'nickname')!.icon).toBeNull()
  })

  it('creates a custom field with an icon and clears it via null', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const created = await $fetch<{ field: FieldEntry }>(
      '/api/records/schema/types/contacts/fields',
      {
        method: 'POST',
        body: { fieldKey: 'priority', kind: 'text', label: 'Priority', icon: 'i-lucide-flag' },
        ...opts
      }
    )
    expect(created.field.icon).toBe('i-lucide-flag')

    const cleared = await $fetch<{ field: FieldEntry }>(
      '/api/records/schema/types/contacts/fields/priority',
      { method: 'PATCH', body: { icon: null }, ...opts }
    )
    expect(cleared.field.icon).toBeNull()

    // The custom field's row IS its definition — clearing the icon must not
    // delete it.
    const rows = await sql`
      SELECT kind, icon_override FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'priority'
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('text')
    expect(rows[0]!.icon_override).toBeNull()
  })
})

describe('admin custom fields (orphan rows with kind)', () => {
  it('creates a key_select custom field and merges it with custom: true', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const created = await $fetch<{ field: FieldEntry }>(
      '/api/records/schema/types/contacts/fields',
      {
        method: 'POST',
        body: {
          fieldKey: 'vip_level',
          kind: 'key_select',
          label: 'VIP level',
          options: { gold: { label: 'Gold' }, silver: { label: 'Silver' } }
        },
        ...opts
      }
    )
    expect(created.field).toMatchObject({ key: 'vip_level', kind: 'key_select', custom: true, orphan: false })

    const res = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    const field = res.fields.find(f => f.key === 'vip_level')!
    expect(field.custom).toBe(true)
    expect(field.options?.gold?.label).toBe('Gold')
  })

  it('rejects reserved and colliding keys', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const reserved = await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'name', kind: 'text', label: 'Name 2' },
      ...opts
    }).catch(e => e)
    expect(reserved.statusCode).toBe(400)

    const collision = await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: { fieldKey: 'nickname', kind: 'text', label: 'Nickname 2' },
      ...opts
    }).catch(e => e)
    expect(collision.statusCode).toBe(409)
  })

  it('refuses a type key the records app uses for its own pages', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const res = await $fetch('/api/records/schema/types', {
      method: 'POST',
      body: { typeKey: 'settings', label: 'Settings', labelSingular: 'Setting' },
      ...withOrgHeader(auth, org.slug)
    }).catch(e => e)
    expect(res.statusCode).toBe(400)
  })
})

describe('option order', () => {
  it('stores a reordered manifest field and drops the order when it matches the code', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const url = '/api/records/schema/types/contacts/fields/reason_closed'
    const codeOrder = ['duplicate', 'not_interested', 'not_responding', 'moved', 'asked_to_be_removed', 'other']

    const patched = await $fetch<{ field: FieldEntry }>(url, {
      method: 'PATCH', body: { optionOrder: ['other', 'moved'] }, ...opts
    })
    const reordered = ['other', 'moved', 'duplicate', 'not_interested', 'not_responding', 'asked_to_be_removed']
    expect(Object.keys(patched.field.options ?? {})).toEqual(reordered)

    let rows = await sql`
      SELECT config FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'reason_closed'
    `
    expect(rows[0]!.config.optionOrder).toEqual(reordered)

    await $fetch(url, { method: 'PATCH', body: { optionOrder: codeOrder }, ...opts })
    rows = await sql`
      SELECT id FROM records_fields
      WHERE org_id = ${org.id} AND type_key = 'contacts' AND field_key = 'reason_closed'
    `
    expect(rows).toHaveLength(0)
  })

  it('keeps a custom field\'s options in the order they were given', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST',
      body: {
        fieldKey: 'tier',
        kind: 'key_select',
        label: 'Tier',
        options: { silver: { label: 'Silver' }, gold: { label: 'Gold' }, bronze: { label: 'Bronze' } }
      },
      ...opts
    })
    let res = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    expect(Object.keys(res.fields.find(f => f.key === 'tier')!.options ?? {})).toEqual(['silver', 'gold', 'bronze'])

    // An added option lands after the stored order.
    await $fetch('/api/records/schema/types/contacts/fields/tier', {
      method: 'PATCH', body: { options: { iron: { label: 'Iron' } } }, ...opts
    })
    res = await $fetch<FieldsResponse>('/api/records/schema/types/contacts/fields', opts)
    expect(Object.keys(res.fields.find(f => f.key === 'tier')!.options ?? {})).toEqual(['silver', 'gold', 'bronze', 'iron'])
  })
})

describe('stale orphan rows', () => {
  it('appear (flagged) for schema managers and are hidden from members', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const member = await addRecordsMember(sql, org.id, ['member'])

    // A row with kind NULL and no manifest field behind it — the leftover of
    // a removed code field.
    await sql`
      INSERT INTO records_fields (id, type_key, field_key, kind, label_override, org_id)
      VALUES (${randomUUID()}, 'contacts', 'old_thing', null, 'Old Thing', ${org.id})
    `

    const managerView = await $fetch<FieldsResponse>(
      '/api/records/schema/types/contacts/fields',
      { ...withOrgHeader(auth, org.slug) }
    )
    const stale = managerView.fields.find(f => f.key === 'old_thing')
    expect(stale).toMatchObject({ orphan: true, custom: false, label: 'Old Thing' })

    const memberView = await $fetch<FieldsResponse>(
      '/api/records/schema/types/contacts/fields',
      { ...withOrgHeader(member.auth, org.slug) }
    )
    expect(memberView.fields.find(f => f.key === 'old_thing')).toBeUndefined()
  })
})

describe('admin custom record types', () => {
  it('creates a type and synthesizes its intrinsic name field', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    const created = await $fetch<{ type: { key: string, custom: boolean } }>(
      '/api/records/schema/types',
      { method: 'POST', body: { typeKey: 'projects', label: 'Projects', labelSingular: 'Project' }, ...opts }
    )
    expect(created.type).toMatchObject({ key: 'projects', custom: true })

    const res = await $fetch<FieldsResponse>('/api/records/schema/types/projects/fields', opts)
    const name = res.fields.find(f => f.key === 'name')
    expect(name).toMatchObject({ column: 'name', required: true, custom: false, orphan: false })
  })
})

describe('type label overrides', () => {
  it('merges an override and reverts to the code default on null', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await $fetch('/api/records/schema/types/contacts', {
      method: 'PATCH', body: { label: 'People' }, ...opts
    })
    let types = await $fetch<{ types: Array<{ key: string, label: string }> }>('/api/records/schema/types', opts)
    expect(types.types.find(t => t.key === 'contacts')!.label).toBe('People')

    await $fetch('/api/records/schema/types/contacts', {
      method: 'PATCH', body: { label: null }, ...opts
    })
    types = await $fetch<{ types: Array<{ key: string, label: string }> }>('/api/records/schema/types', opts)
    expect(types.types.find(t => t.key === 'contacts')!.label).toBe('Contacts')

    // Full revert leaves no row behind.
    const rows = await sql`
      SELECT id FROM records_types WHERE org_id = ${org.id} AND type_key = 'contacts'
    `
    expect(rows).toHaveLength(0)
  })
})
