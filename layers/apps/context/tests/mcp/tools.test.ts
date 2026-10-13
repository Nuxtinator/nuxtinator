// MCP tool registry smoke test — confirms the 16 tools are declared with
// the right scopes and that `update_section`'s optional optimistic-lock
// field is intact. The write tools are driven end to end over /mcp in
// write-tools.test.ts; auth / scope gating / rate limits are covered by the
// MCP layer's own harness.
import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOOLS_FILE = fileURLToPath(new URL('../../server/mcp/context-tools.ts', import.meta.url))

describe('context MCP tools file', () => {
  it('declares the 16 expected tool names', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const expected = [
      'list_orgs',
      'list_portfolios',
      'list_sections',
      'read_section',
      'bulk_read_sections',
      'read_organization',
      'update_section',
      'bulk_update_sections',
      'create_portfolio',
      'create_section',
      'bulk_create_sections',
      'delete_section',
      'list_suggestions',
      'withdraw_suggestion',
      'read_suggestion',
      'update_suggestion'
    ]
    for (const name of expected) {
      expect(src).toContain(`name: '${name}'`)
    }
  })

  it('assigns context.read to all eight read tools', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const readMatches = src.match(/scope:\s*'context\.read'/g) ?? []
    expect(readMatches.length).toBe(8)
  })

  it('assigns context.write to the update tools and the suggestion write tools', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const writeMatches = src.match(/scope:\s*'context\.write'/g) ?? []
    expect(writeMatches.length).toBe(4)
  })

  it('assigns the portfolio-create and custom-section scopes to the create/delete tools', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const createMatches = src.match(/scope:\s*'context\.portfolio\.create'/g) ?? []
    expect(createMatches.length).toBe(1)
    const customMatches = src.match(/scope:\s*'context\.section\.custom'/g) ?? []
    expect(customMatches.length).toBe(3)
  })

  it('marks delete_section destructive so it draws the destructive rate bucket', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const destructive = src.match(/destructive:\s*true/g) ?? []
    expect(destructive.length).toBe(1)
  })

  it('every tool except list_orgs declares the optional org input', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const orgInputs = src.match(/\borg: orgInput\b/g) ?? []
    expect(orgInputs.length).toBe(15)
    const orgScopedCalls = src.match(/runInOrgTransaction\(ctx\.event, \{ org: input\.org, userId: ctx\.auth\.userId \}/g) ?? []
    expect(orgScopedCalls.length).toBe(15)
  })

  it('the content-writing tools carry the privacy instruction in their descriptions', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    expect(src).toMatch(/const PRIVACY_INSTRUCTION = '[^']*initials[^']*'/)
    const withInstruction = src.match(/description: `[^`]*\$\{PRIVACY_INSTRUCTION\}`/g) ?? []
    expect(withInstruction).toHaveLength(3)
    expect(src).toMatch(/name: 'update_section',\s*(?:title: '[^']*',\s*)?description: `[^`]*\$\{PRIVACY_INSTRUCTION\}`/)
    expect(src).toMatch(/name: 'bulk_update_sections',\s*(?:title: '[^']*',\s*)?description: `[^`]*\$\{PRIVACY_INSTRUCTION\}`/)
    expect(src).toMatch(/name: 'update_suggestion',\s*(?:title: '[^']*',\s*)?description: `[^`]*\$\{PRIVACY_INSTRUCTION\}`/)
  })

  it('update_section accepts optional last_edited_at for optimistic locking', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    expect(src).toMatch(/last_edited_at:\s*z\.string\(\)\.datetime\(\)\.optional\(\)/)
  })

  it('both write tools stamp versions with source mcp', async () => {
    const src = await fs.readFile(TOOLS_FILE, 'utf8')
    const saves = src.match(/saveSectionContent\(/g) ?? []
    const stamped = src.match(/saveSectionContent\([^)]*\{ source: 'mcp' \}/g) ?? []
    expect(saves.length).toBe(2)
    expect(stamped.length).toBe(2)
  })

  // Read-tool dispatch over /mcp is not exercised here yet; write-tools.test.ts
  // has the bearer-minting recipe to reuse.
  it.todo('dispatches each read tool via /mcp JSON-RPC with a valid bearer token')
})
