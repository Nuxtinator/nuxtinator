// The CRM MCP tools over the real /mcp transport with issued bearers: the
// crm.read / crm.write split, the per-type permission paths (hidden record,
// custom type without a grant, update without a share), before/after
// changes, "via <client>" attribution, consent never
// granted as a side effect, closing with a reason, and the `org` input.
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  createCrmOrg,
  addCrmMember,
  addTestMembership,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool,
  listMcpTools,
  CRM_TEST_MCP_CLIENT_NAME,
  type McpToolResult
} from '../helpers'

type SqlClient = ReturnType<typeof postgres>
type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

const ALL_SCOPES = ['crm.read', 'crm.write']

async function createRole(db: SqlClient, orgId: string, permissions: string[]): Promise<string> {
  const name = `test-crm-mcp-${randomUUID().slice(0, 8)}`
  await db`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'crm mcp test role', ${permissions}::text[], ${orgId})
  `
  return name
}

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/crm/records/contacts', { method: 'POST', body: { fields }, ...opts })
}

function email(tag: string): string {
  return `test-crm-${tag}-${randomUUID().slice(0, 8)}@example.org`
}

function ok(res: McpToolResult): McpToolResult {
  expect(res.isError, res.content.map(c => c.text).join('\n')).toBeFalsy()
  return res
}

function data(res: McpToolResult): Record<string, unknown> {
  return ok(res).structuredContent!
}

describe('crm MCP tool listing and scopes', () => {
  it('lists reads as read-only, writes as not destructive, and offers no delete tool', async () => {
    const { user } = await createCrmOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const tools = new Map((await listMcpTools(token)).filter(t => t.name.startsWith('crm_')).map(t => [t.name, t.annotations]))
    expect(tools.get('crm_search_records')).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(tools.get('crm_get_record')).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(tools.get('crm_update_record')).toBeUndefined()
    expect(tools.has('crm_update_record')).toBe(true)
    expect(tools.has('crm_close_record')).toBe(true)
    expect([...tools.keys()].some(n => n.includes('delete'))).toBe(false)
  })

  it('lets a crm.read token read but not write', async () => {
    const { org, user, auth } = await createCrmOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-crm Reader' })
    const { token } = await issueMcpBearer(sql, user.id, ['crm.read'])

    data(await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id: rec.id }))

    const update = await callMcpTool(token, 'crm_update_record', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'x' } })
    expect(update.isError).toBe(true)
    expect(update.structuredContent).toMatchObject({ error: 'insufficient_scope', required: 'crm.write' })
  })
})

describe('crm MCP permission paths', () => {
  it('hides a record the caller may not see', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-crm Hidden' })
    const member = await addCrmMember(sql, org.id, ['member'])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)

    const get = await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id: rec.id })
    expect(get.isError).toBe(true)
    expect(get.content[0]!.text).toContain('Record not found')

    const search = data(await callMcpTool(token, 'crm_search_records', { org: org.slug, type: 'contacts', query: 'Hidden' }))
    expect(search.total).toBe(0)
  })

  it('refuses a custom type the caller has no grant on', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const typeKey = `test_proj_${randomUUID().slice(0, 6)}`
    await $fetch('/api/crm/schema/types', {
      method: 'POST',
      body: { typeKey, label: 'Projects', labelSingular: 'Project' },
      ...adminOpts
    })
    await $fetch(`/api/crm/records/${typeKey}`, { method: 'POST', body: { fields: { name: 'test-crm Project' } }, ...adminOpts })

    // Contacts access but none of the crm.records.* slugs custom types share.
    const role = await createRole(sql, org.id, ['crm.access', 'crm.read', 'crm.write', 'crm.contacts.read', 'crm.contacts.create'])
    const member = await addCrmMember(sql, org.id, [role])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)

    const types = ok(await callMcpTool(token, 'crm_list_record_types', { org: org.slug }))
    const keys = (types.structuredContent!.types as Array<{ key: string }>).map(t => t.key)
    expect(keys).toContain('contacts')
    expect(keys).not.toContain(typeKey)

    const search = await callMcpTool(token, 'crm_search_records', { org: org.slug, type: typeKey })
    expect(search.isError).toBe(true)
    expect(search.content[0]!.text).toMatch(/^Forbidden/)

    const create = await callMcpTool(token, 'crm_create_record', { org: org.slug, type: typeKey, fields: { name: 'test-crm Nope' } })
    expect(create.isError).toBe(true)
  })

  it('refuses an update without an edit share, and allows it with one', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const adminOpts = withOrgHeader(auth, org.slug)
    const rec = await createContact(adminOpts, { name: 'test-crm Shared' })
    const role = await createRole(sql, org.id, ['crm.access', 'crm.read', 'crm.write', 'crm.contacts.read'])
    const member = await addCrmMember(sql, org.id, [role])
    const { token } = await issueMcpBearer(sql, member.user.id, ALL_SCOPES)
    const share = (level: 'view' | 'edit') => $fetch(`/api/crm/records/contacts/${rec.id}/shares`, {
      method: 'POST', body: { userId: member.user.id, level }, ...adminOpts
    })

    await share('view')
    data(await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id: rec.id }))
    const refused = await callMcpTool(token, 'crm_update_record', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Shy' } })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/^Forbidden/)
    const comment = await callMcpTool(token, 'crm_add_comment', { org: org.slug, type: 'contacts', id: rec.id, body: 'hello' })
    expect(comment.isError).toBe(true)

    await share('edit')
    ok(await callMcpTool(token, 'crm_update_record', { org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Shy' } }))
  })

  it('runs in the org named by the `org` input and refuses an org the user is not in', async () => {
    const { org, user } = await createCrmOrgWith(sql, ['admin'])
    const other = await createCrmOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: other.id, roles: ['admin'] })
    const stranger = await createCrmOrg(sql)
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)

    const created = ok(await callMcpTool(token, 'crm_create_record', { org: other.slug, type: 'contacts', fields: { name: 'test-crm Elsewhere' } }))
    const id = (created.structuredContent!.record as { id: string }).id
    const [row] = await sql`SELECT org_id FROM crm_records WHERE id = ${id}`
    expect(row!.org_id).toBe(other.id)

    const missing = await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id })
    expect(missing.isError).toBe(true)

    const denied = await callMcpTool(token, 'crm_search_records', { org: stranger.slug, type: 'contacts' })
    expect(denied.isError).toBe(true)
  })
})

describe('crm MCP writes', () => {
  it('creates a contact with an email without granting consent, and labels the timeline with the client', async () => {
    const { org, user } = await createCrmOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const address = email('card')

    const created = ok(await callMcpTool(token, 'crm_create_record', {
      org: org.slug, type: 'contacts', fields: { name: 'test-crm Card', contact_email: [address] }
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

    const timeline = data(await callMcpTool(token, 'crm_list_timeline', { org: org.slug, type: 'contacts', id }))
    const entries = timeline.entries as Array<{ action?: string, viaClient: string | null }>
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every(e => e.viaClient === CRM_TEST_MCP_CLIENT_NAME)).toBe(true)
  })

  it('returns before/after values for changed fields only', async () => {
    const { org, user, auth } = await createCrmOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-crm Bob', nickname: 'Bobby' })
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)

    const res = ok(await callMcpTool(token, 'crm_update_record', {
      org: org.slug, type: 'contacts', id: rec.id, fields: { nickname: 'Rob', gender: 'male' }
    }))
    expect(res.structuredContent!.changes).toEqual(expect.arrayContaining([
      { field: 'nickname', label: 'Nickname', before: 'Bobby', after: 'Rob' },
      { field: 'gender', label: 'Gender', before: null, after: 'male' }
    ]))
    expect((res.structuredContent!.changes as unknown[])).toHaveLength(2)
  })

  it('links and unlinks an address by value and records consent with evidence', async () => {
    const { org, user, auth } = await createCrmOrgWith(sql, ['admin'])
    const rec = await createContact(withOrgHeader(auth, org.slug), { name: 'test-crm Consent' })
    const { token, clientId } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const address = email('consent')

    ok(await callMcpTool(token, 'crm_link_channel', { org: org.slug, type: 'contacts', id: rec.id, value: address }))

    const noEvidence = await callMcpTool(token, 'crm_set_consent', {
      org: org.slug, type: 'contacts', id: rec.id, address, purpose: 'marketing', status: 'opt_in', source: 'verbal'
    })
    expect(noEvidence.isError).toBe(true)

    const granted = ok(await callMcpTool(token, 'crm_set_consent', {
      org: org.slug, type: 'contacts', id: rec.id, address: address.toUpperCase(), purpose: 'marketing',
      status: 'opt_in', source: 'verbal', evidence: 'Said yes to the newsletter on Sunday.'
    }))
    expect(granted.structuredContent).toMatchObject({ changed: true, before: null, after: 'opt_in' })

    const [event] = await sql`
      SELECT e.source, e.ip, e.user_agent, e.meta, e.actor_user_id FROM crm_consent_events e
      JOIN crm_channels ch ON ch.id = e.channel_id
      WHERE ch.org_id = ${org.id}
    `
    expect(event).toMatchObject({ source: 'verbal', ip: null, user_agent: null, actor_user_id: user.id })
    expect(event!.meta).toMatchObject({ note: 'Said yes to the newsletter on Sunday.', client_id: clientId })

    ok(await callMcpTool(token, 'crm_unlink_channel', { org: org.slug, type: 'contacts', id: rec.id, address }))
    const after = data(await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id: rec.id }))
    expect(after.channels).toEqual([])
  })
})

describe('closing records', () => {
  it('requires a reason, revokes consent for "asked to be removed", and clears the reason on reopen', async () => {
    const { org, user, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const shared = email('family')
    const rec = await createContact(opts, { name: 'test-crm Leaver', contact_email: [shared] })
    const sibling = await createContact(opts, { name: 'test-crm Sibling', contact_email: [shared] })
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    ok(await callMcpTool(token, 'crm_set_consent', {
      org: org.slug, type: 'contacts', id: rec.id, address: shared, purpose: 'marketing',
      status: 'opt_in', source: 'form', evidence: 'Signed up on the website.'
    }))

    const noReason = await callMcpTool(token, 'crm_close_record', { org: org.slug, type: 'contacts', id: rec.id })
    expect(noReason.isError).toBe(true)
    expect(noReason.content[0]!.text).toContain('reason')

    const closed = ok(await callMcpTool(token, 'crm_close_record', {
      org: org.slug, type: 'contacts', id: rec.id, reason: 'asked_to_be_removed'
    }))
    expect(closed.structuredContent).toMatchObject({ consentRevoked: true, record: { status: 'closed', closed: true } })

    // Consent belongs to the address, so the sibling sharing it loses it too.
    const siblingView = data(await callMcpTool(token, 'crm_get_record', { org: org.slug, type: 'contacts', id: sibling.id }))
    const channel = (siblingView.channels as Array<{ consents: Array<{ purpose: string, status: string }> }>)[0]!
    expect(channel.consents).toEqual([expect.objectContaining({ purpose: 'marketing', status: 'opt_out' })])

    // Closed records drop out of search unless asked for.
    const search = data(await callMcpTool(token, 'crm_search_records', { org: org.slug, type: 'contacts', query: 'Leaver' }))
    expect(search.total).toBe(0)
    const withClosed = data(await callMcpTool(token, 'crm_search_records', { org: org.slug, type: 'contacts', query: 'Leaver', includeClosed: true }))
    expect(withClosed.total).toBe(1)

    const reopened = ok(await callMcpTool(token, 'crm_update_record', { org: org.slug, type: 'contacts', id: rec.id, fields: { status: 'active' } }))
    expect(reopened.structuredContent!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'reason_closed', before: 'asked_to_be_removed', after: null })
    ]))
  })

  it('applies the same rules to the record route', async () => {
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)
    const rec = await createContact(opts, { name: 'test-crm Route' })
    const patch = (fields: Record<string, unknown>) => $fetch<{ fields: Record<string, unknown> }>(
      `/api/crm/records/contacts/${rec.id}`, { method: 'PATCH', body: { fields }, ...opts }
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
    const { org, auth } = await createCrmOrgWith(sql, ['admin'])
    const opts = withOrgHeader(auth, org.slug)

    await expect($fetch('/api/crm/schema/types/contacts/fields/gender', {
      method: 'PATCH', body: { options: { male: { label: 'Male', closed: true } } }, ...opts
    })).rejects.toMatchObject({ statusCode: 400 })

    await $fetch('/api/crm/schema/types/contacts/fields/status', {
      method: 'PATCH', body: { options: { paused: { label: 'Paused', color: 'warning', closed: true } } }, ...opts
    })
    await $fetch('/api/crm/schema/types/contacts/fields/reason_closed', {
      method: 'PATCH', body: { options: { other: { label: 'Other', revokesConsent: true } } }, ...opts
    })
    const fields = await $fetch<{ closedReasonField: string | null, fields: Array<{ key: string, options: Record<string, { closed?: boolean, revokesConsent?: boolean }> | null }> }>(
      '/api/crm/schema/types/contacts/fields', opts
    )
    const status = fields.fields.find(f => f.key === 'status')!
    expect(status.options!.paused!.closed).toBe(true)
    const reason = fields.fields.find(f => f.key === 'reason_closed')!
    expect(reason.options!.other!.revokesConsent).toBeUndefined()
    expect(reason.options!.asked_to_be_removed!.revokesConsent).toBe(true)
    expect(fields.closedReasonField).toBe('reason_closed')

    await $fetch('/api/crm/schema/types/contacts/fields', {
      method: 'POST', body: { fieldKey: 'why_gone', kind: 'key_select', label: 'Why gone', options: { bored: { label: 'Bored' } } }, ...opts
    })
    const updated = await $fetch<{ type: { closedReasonField: string | null } }>('/api/crm/schema/types/contacts', {
      method: 'PATCH', body: { closedReasonField: 'why_gone' }, ...opts
    })
    expect(updated.type.closedReasonField).toBe('why_gone')
    await expect($fetch('/api/crm/schema/types/contacts', {
      method: 'PATCH', body: { closedReasonField: 'nickname' }, ...opts
    })).rejects.toMatchObject({ statusCode: 400 })
  })
})
