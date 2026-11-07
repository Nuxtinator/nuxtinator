// The crm MCP tools over the real /mcp transport with issued bearers: adding
// and removing addresses, consent recorded only with evidence, and consent
// revoked when a contact is closed as "asked to be removed".
import { describe, it, expect, afterEach } from 'vitest'
import { $fetch } from '@nuxt/test-utils/e2e'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupCrmTestData,
  createCrmOrgWith,
  withOrgHeader,
  issueMcpBearer,
  callMcpTool,
  listMcpTools,
  type McpToolResult
} from '../helpers'

type Opts = ReturnType<typeof withOrgHeader>

const sql = getHostAdminDb()
afterEach(async () => { await cleanupCrmTestData(sql) })

const ALL_SCOPES = ['records.read', 'records.write']

async function createContact(opts: Opts, fields: Record<string, unknown>): Promise<{ id: string }> {
  return await $fetch<{ id: string }>('/api/records/entries/contacts', { method: 'POST', body: { fields }, ...opts })
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

describe('crm MCP tools', () => {
  it('lists the address tools under the records scopes', async () => {
    const { user } = await createCrmOrgWith(sql, ['admin'])
    const { token } = await issueMcpBearer(sql, user.id, ALL_SCOPES)
    const names = (await listMcpTools(token)).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['crm_get_addresses', 'crm_link_channel', 'crm_unlink_channel', 'crm_set_consent']))
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
    const after = data(await callMcpTool(token, 'crm_get_addresses', { org: org.slug, type: 'contacts', id: rec.id }))
    expect(after.channels).toEqual([])
  })

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

    const noReason = await callMcpTool(token, 'records_close', { org: org.slug, type: 'contacts', id: rec.id })
    expect(noReason.isError).toBe(true)
    expect(noReason.content[0]!.text).toContain('reason')

    const closed = ok(await callMcpTool(token, 'records_close', {
      org: org.slug, type: 'contacts', id: rec.id, reason: 'asked_to_be_removed'
    }))
    expect(closed.structuredContent).toMatchObject({ consentRevoked: true, record: { status: 'closed', closed: true } })

    // Consent belongs to the address, so the sibling sharing it loses it too.
    const siblingView = data(await callMcpTool(token, 'crm_get_addresses', { org: org.slug, type: 'contacts', id: sibling.id }))
    const channel = (siblingView.channels as Array<{ consents: Array<{ purpose: string, status: string }> }>)[0]!
    expect(channel.consents).toEqual([expect.objectContaining({ purpose: 'marketing', status: 'opt_out' })])

    // Closed records drop out of search unless asked for.
    const search = data(await callMcpTool(token, 'records_search', { org: org.slug, type: 'contacts', query: 'Leaver' }))
    expect(search.total).toBe(0)
    const withClosed = data(await callMcpTool(token, 'records_search', { org: org.slug, type: 'contacts', query: 'Leaver', includeClosed: true }))
    expect(withClosed.total).toBe(1)

    const reopened = ok(await callMcpTool(token, 'records_update', { org: org.slug, type: 'contacts', id: rec.id, fields: { status: 'active' } }))
    expect(reopened.structuredContent!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'reason_closed', before: 'asked_to_be_removed', after: null })
    ]))
  })
})
