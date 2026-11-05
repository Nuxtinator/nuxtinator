// The records MCP tools over the real /mcp transport with issued bearers:
// the records.read / records.write split, the per-type permission paths
// (hidden record, custom type without a grant, update without a share),
// before/after changes, "via <client>" attribution, consent never granted as
// a side effect, closing rules, the schema tools, and the `org` input.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  getHostAdminDb,
  cleanupRecordsTestData,
  createRecordsOrgWith,
  createRecordsOrg,
  addRecordsMember,
  addTestMembership,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool,
  listMcpTools,
  RECORDS_TEST_MCP_CLIENT_NAME,
  type McpToolResult
} from '../helpers'

type SqlClient = ReturnType<typeof postgres>
type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupRecordsTestData(sql) })

const ALL_SCOPES = ['records.read', 'records.write']

async function createRole(db: SqlClient, orgId: string, permissions: string[]): Promise<string> {
  const name = `test-records-mcp-${randomUUID().slice(0, 8)}`
  await db`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'crm mcp test role', ${permissions}::text[], ${orgId})
  `
  return name
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', { method: 'POST', body: { fields }, ...opts })
}

function email(tag: string): string {
  return `test-records-${tag}-${randomUUID().slice(0, 8)}@example.org`
}

function ok(res: McpToolResult): McpToolResult {
  expect(res.isError, res.content.map(c => c.text).join('\n')).toBeFalsy()
  return res
}

function data(res: McpToolResult): Record<string, unknown> {
  return ok(res).structuredContent!
}

describe('records MCP tool listing and scopes', () => {
  it('lists reads as read-only, writes as not destructive, and offers no delete tool', async () => {
    const { user } = await createRecordsOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const tools = new Map((await listMcpTools(token)).filter(t => t.name.startsWith('records_')).map(t => [t.name, t.annotations]))
    expect(tools.get('records_search')).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(tools.get('records_get')).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(tools.get('records_update')).toBeUndefined()
    expect(tools.has('records_update')).toBe(true)
    expect(tools.has('records_close')).toBe(true)
    expect([...tools.keys()].some(n => n.includes('delete'))).toBe(false)
  })

  it('lets a records.read token read but not write', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-records Reader' })
    const { token } = await issueMcpBearer(sql, user.id, ['records.read'])

    data(await callMcpTool(token, 'records_get', { org: org.slug, type: 'contacts', id: rec.id }))

    const update = await callMcpTool(token, 'records_update', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'x' } })
    expect(update.isError).toBe(true)
    expect(update.structuredContent).toMatchObject({ error: 'insufficient_scope', required: 'records.write' })
  })
})

describe('records MCP permission paths', () => {
  it('hides a record the caller may not see', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-records Hidden' })
    const member = await addRecordsMember(sql, org.id, ['member'])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)

    const get = await callMcpTool(token, 'records_get', { org: org.slug, type: 'contacts', id: rec.id })
    expect(get.isError).toBe(true)
    expect(get.content[0]!.text).toContain('Record not found')

    const search = data(await callMcpTool(token, 'records_search', { org: org.slug, type: 'contacts', query: 'Hidden' }))
    expect(search.total).toBe(0)
  })

  it('refuses a custom type the caller has no grant on', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const typeKey = `test_proj_${randomUUID().slice(0, 6)}`
    await $fetch('/api/records/schema/types', {
      method: 'POST',
      body: { typeKey, label: 'Projects', labelSingular: 'Project' },
      ...adminOpts
    })
    await $fetch(`/api/records/entries/${typeKey}`, { method: 'POST', body: { fields: { name: 'test-records Project' } }, ...adminOpts })

    // Contacts access but none of the records.entries.* slugs custom types share.
    const role = await createRole(sql, org.id, ['crm.access', 'records.read', 'records.write', 'crm.contacts.read', 'crm.contacts.create'])
    const member = await addRecordsMember(sql, org.id, [role])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)

    const types = ok(await callMcpTool(token, 'records_list_types', { org: org.slug }))
    const keys = (types.structuredContent!.types as Array<{ key: string }>).map(t => t.key)
    expect(keys).toContain('contacts')
    expect(keys).not.toContain(typeKey)

    const search = await callMcpTool(token, 'records_search', { org: org.slug, type: typeKey })
    expect(search.isError).toBe(true)
    expect(search.content[0]!.text).toMatch(/^Forbidden/)

    const create = await callMcpTool(token, 'records_create', { org: org.slug, type: typeKey, fields: { name: 'test-records Nope' } })
    expect(create.isError).toBe(true)
  })

  it('refuses an update without an edit share, and allows it with one', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const rec = await createContact(adminOpts, { name: 'test-records Shared' })
    const role = await createRole(sql, org.id, ['crm.access', 'records.read', 'records.write', 'crm.contacts.read'])
    const member = await addRecordsMember(sql, org.id, [role])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)
    const share = (level: 'view' | 'edit') => $fetch(`/api/records/entries/contacts/${rec.id}/shares`, {
      method: 'POST', body: { userId: member.user.id, level }, ...adminOpts
    })

    await share('view')
    data(await callMcpTool(token, 'records_get', { org: org.slug, type: 'contacts', id: rec.id }))
    const refused = await callMcpTool(token, 'records_update', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Shy' } })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/^Forbidden/)
    const comment = await callMcpTool(token, 'records_add_comment', { org: org.slug, type: 'contacts', id: rec.id, body: 'hello' })
    expect(comment.isError).toBe(true)

    await share('edit')
    ok(await callMcpTool(token, 'records_update', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Shy' } }))
  })

  it('runs in the org named by the `org` input and refuses an org the user is not in', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const other = await createRecordsOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: other.id, roles: ['admin'] })
    const stranger = await createRecordsOrg(sql)
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)

    const created = ok(await callMcpTool(token, 'records_create', { org: other.slug, type: 'contacts', fields: { name: 'test-records Elsewhere' } }))
    const id = (created.structuredContent!.record as { id: string }).id
    const [row] = await sql`SELECT org_id FROM records_entries WHERE id = ${id}`
    expect(row!.org_id).toBe(other.id)

    const missing = await callMcpTool(token, 'records_get', { org: org.slug, type: 'contacts', id })
    expect(missing.isError).toBe(true)

    const denied = await callMcpTool(token, 'records_search', { org: stranger.slug, type: 'contacts' })
    expect(denied.isError).toBe(true)
  })
})

describe('records MCP writes', () => {
  it('creates a contact with an email without granting consent, and labels the timeline with the client', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const address = email('card')

    const created = ok(await callMcpTool(token, 'records_create', {
      org: org.slug, type: 'contacts', fields: { name: 'test-records Card', contact_email: [address] }
    }))
    const id = (created.structuredContent!.record as { id: string }).id
    const changes = created.structuredContent!.changes as Array<{ field: string, before: unknown }>
    expect(changes.map(c => c.field)).toEqual(expect.arrayContaining(['name', 'contact_email']))
    expect(changes.every(c => c.before === null)).toBe(true)

    const consents = await sql`
      SELECT c.* FROM crm_channel_consents c JOIN crm_channels ch ON ch.id = c.channel_id
      WHERE ch.org_id = ${org.id}
    `
    expect(consents).toHaveLength(0)

    const timeline = data(await callMcpTool(token, 'records_list_timeline', { org: org.slug, type: 'contacts', id }))
    const entries = timeline.entries as Array<{ action?: string, viaClient: string | null }>
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every(e => e.viaClient === RECORDS_TEST_MCP_CLIENT_NAME)).toBe(true)
  })

  it('returns before/after values for changed fields only', async () => {
    const { org, user, auth } = await createRecordsOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-records Bob', nickname: 'Bobby' })
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)

    const res = ok(await callMcpTool(token, 'records_update', {
      org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Rob', gender: 'male' }
    }))
    expect(res.structuredContent!.changes).toEqual(expect.arrayContaining([
      { field: 'nickname', label: 'Nickname', before: 'Bobby', after: 'Rob' },
      { field: 'gender', label: 'Gender', before: null, after: 'male' }
    ]))
    expect((res.structuredContent!.changes as unknown[])).toHaveLength(2)
  })
})

describe('closing records', () => {
  it('applies the same rules to the record route', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-records Route' })
    const patch = (fields: Record<string, unknown>) => $fetch<{ fields: Record<string, unknown> }>(
      `/api/records/entries/contacts/${rec.id}`, { method: 'PATCH', body: { fields }, ...opts }
    )

    await expect(patch({ status: 'closed' })).rejects.toMatchObject({ statusCode: 400 })
    const closed = await patch({ status: 'closed', reason_closed: 'moved' })
    expect(closed.fields).toMatchObject({ status: 'closed', reason_closed: 'moved' })
    // Editing another field of a closed record doesn't need the reason again.
    await patch({ nickname: 'Gone' })
    const reopened = await patch({ status: 'active' })
    expect(reopened.fields.reason_closed).toBeNull()
  })

  it('lets admins mark status options closed and pick the reason field, but not set consent rules', async () => {
    const { org, auth } = await createRecordsOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect($fetch('/api/records/schema/types/contacts/fields/gender', {
      method: 'PATCH', body: { options: { male: { label: 'Male', closed: true } } }, ...opts
    })).rejects.toMatchObject({ statusCode: 400 })

    await $fetch('/api/records/schema/types/contacts/fields/status', {
      method: 'PATCH', body: { options: { paused: { label: 'Paused', color: 'warning', closed: true } } }, ...opts
    })
    await $fetch('/api/records/schema/types/contacts/fields/reason_closed', {
      method: 'PATCH', body: { options: { other: { label: 'Other', revokesConsent: true } } }, ...opts
    })
    const fields = await $fetch<{ closedReasonField: string | null, fields: Array<{ key: string, options: Record<string, { closed?: boolean, revokesConsent?: boolean }> | null }> }>(
      '/api/records/schema/types/contacts/fields', opts
    )
    const status = fields.fields.find(f => f.key === 'status')!
    expect(status.options!.paused!.closed).toBe(true)
    const reason = fields.fields.find(f => f.key === 'reason_closed')!
    expect(reason.options!.other!.revokesConsent).toBeUndefined()
    expect(reason.options!.asked_to_be_removed!.revokesConsent).toBe(true)
    expect(fields.closedReasonField).toBe('reason_closed')

    await $fetch('/api/records/schema/types/contacts/fields', {
      method: 'POST', body: { fieldKey: 'why_gone', kind: 'key_select', label: 'Why gone', options: { bored: { label: 'Bored' } } }, ...opts
    })
    const updated = await $fetch<{ type: { closedReasonField: string | null } }>('/api/records/schema/types/contacts', {
      method: 'PATCH', body: { closedReasonField: 'why_gone' }, ...opts
    })
    expect(updated.type.closedReasonField).toBe('why_gone')
    await expect($fetch('/api/records/schema/types/contacts', {
      method: 'PATCH', body: { closedReasonField: 'nickname' }, ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('schema and views tools', () => {
  it('runs "start tracking events" end to end: create the type, a board, and records', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, [...ALL_SCOPES, 'records.schema.manage', 'views.use'])

    const types = data(await callMcpTool(token, 'records_list_types', { org: org.slug }))
    expect(types.kinds).toEqual(expect.arrayContaining(['key_select', 'connection']))

    const created = data(await callMcpTool(token, 'records_create_type', {
      org: org.slug,
      key: 'test_records_events',
      label: 'Events',
      labelSingular: 'Event',
      fields: [
        { key: 'stage', label: 'Stage', kind: 'key_select', options: { planned: { label: 'Planned' }, held: { label: 'Held' } } },
        { key: 'venue', label: 'Venue', kind: 'text' }
      ]
    }))
    expect((created.fields as Array<{ key: string }>).map(f => f.key)).toEqual(expect.arrayContaining(['name', 'stage', 'venue']))

    ok(await callMcpTool(token, 'records_add_field', {
      org: org.slug, type: 'test_records_events', field: { key: 'starts_on', label: 'Starts on', kind: 'date' }
    }))
    ok(await callMcpTool(token, 'records_update_field', {
      org: org.slug, type: 'test_records_events', field: 'stage', options: { cancelled: { label: 'Cancelled' } }
    }))

    const board = data(await callMcpTool(token, 'views_create', {
      org: org.slug, name: 'Events board', recordType: 'test_records_events', layout: 'kanban', groupField: 'stage'
    }))
    const viewId = (board.view as { id: string }).id

    const event = data(await callMcpTool(token, 'records_create', {
      org: org.slug, type: 'test_records_events', fields: { name: 'test-records Spring gathering', stage: 'planned', venue: 'Hall' }
    }))
    const eventId = (event.record as { id: string }).id

    ok(await callMcpTool(token, 'views_move_card', {
      org: org.slug, view: viewId, record: eventId, fromColumn: 'planned', toColumn: 'held'
    }))
    const read = data(await callMcpTool(token, 'views_get_board', { org: org.slug, view: viewId }))
    const columns = read.columns as Array<{ key: string, cards: Array<{ id: string }> }>
    expect(columns.find(c => c.key === 'held')?.cards.map(c => c.id)).toEqual([eventId])
    expect(columns.map(c => c.key)).toEqual(expect.arrayContaining(['planned', 'held', 'cancelled']))

    // A second tab: the planned events, as a list.
    const other = data(await callMcpTool(token, 'records_create', {
      org: org.slug, type: 'test_records_events', fields: { name: 'test-records Autumn retreat', stage: 'planned', venue: 'Barn' }
    }))
    const otherId = (other.record as { id: string }).id
    const added = data(await callMcpTool(token, 'views_add_tab', {
      org: org.slug,
      view: viewId,
      name: 'Planned',
      layout: 'list',
      filter: { match: 'all', rules: [{ field: 'stage', op: 'is', value: 'planned' }] }
    }))
    const tabId = (added.tab as { id: string }).id
    let planned = data(await callMcpTool(token, 'views_get_board', { org: org.slug, view: viewId, tab: tabId }))
    expect((planned.columns as Array<{ cards: Array<{ id: string }> }>)[0]!.cards.map(c => c.id)).toEqual([otherId])

    // The view's own filter narrows every tab: no barns.
    ok(await callMcpTool(token, 'views_set_filter', {
      org: org.slug, view: viewId, filter: { match: 'all', rules: [{ field: 'venue', op: 'is', value: 'Hall' }] }
    }))
    planned = data(await callMcpTool(token, 'views_get_board', { org: org.slug, view: viewId, tab: tabId }))
    expect((planned.columns as Array<{ cards: unknown[] }>)[0]!.cards).toEqual([])
    const listed = data(await callMcpTool(token, 'views_list', { org: org.slug }))
    const mine = (listed.views as Array<{ id: string, tabs: Array<{ name: string, layout: string }> }>).find(v => v.id === viewId)
    expect(mine?.tabs).toEqual([{ id: expect.any(String), name: 'Board', layout: 'kanban' }, { id: tabId, name: 'Planned', layout: 'list' }])
  })

  it('refuses schema changes to a token without records.schema.manage', async () => {
    const { org, user } = await createRecordsOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const res = await callMcpTool(token, 'records_create_type', {
      org: org.slug, key: 'test_records_nope', label: 'Nope', labelSingular: 'Nope'
    })
    expect(res.isError).toBe(true)
  })
})
