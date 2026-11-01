// MCP tools get the permissions the web routes give in the org a call
// targets: membership roles plus grants in that org. A host admin with a
// lesser role in an org is refused there, and allowed where their role
// carries the permission.
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  getHostAdminDb,
  cleanupContextTestData,
  createContextUser,
  createContextOrg,
  addTestMembership,
  issueMcpBearer,
  callMcpTool
} from '../helpers'

const sql = getHostAdminDb()

async function createEmptyRole(orgId: string): Promise<string> {
  const name = `test-context-empty-${randomUUID().slice(0, 8)}`
  await sql`
    INSERT INTO custom_roles (id, name, description, permissions, org_id)
    VALUES (${randomUUID()}, ${name}, 'no permissions', '{}'::text[], ${orgId})
  `
  return name
}

describe('MCP permissions per org', () => {
  afterEach(async () => {
    await cleanupContextTestData(sql)
    await sql`DELETE FROM oauth_clients WHERE client_id LIKE 'test-context-%'`
  })

  it('refuses a host admin in an org where their role lacks the scope, and allows it where it has it', async () => {
    const user = await createContextUser(sql)
    await sql`UPDATE users SET is_admin = true WHERE id = ${user.id}`
    const plain = await createContextOrg(sql)
    const owned = await createContextOrg(sql)
    await addTestMembership(sql, { user_id: user.id, org_id: plain.id, roles: [await createEmptyRole(plain.id)] })
    await addTestMembership(sql, { user_id: user.id, org_id: owned.id, roles: ['admin'] })
    const token = await issueMcpBearer(sql, user.id, ['context.read'])

    const denied = await callMcpTool(token, 'list_portfolios', { org: plain.slug })
    expect(denied.isError).toBe(true)
    expect(denied.structuredContent).toMatchObject({ error: 'insufficient_permission', required: 'context.read' })

    const allowed = await callMcpTool(token, 'list_portfolios', { org: owned.slug })
    expect(allowed.isError, allowed.content[0]?.text).toBeFalsy()
  })
})
