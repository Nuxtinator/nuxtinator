// `list_orgs` MCP tool: the org picker for every tool that takes an `org`
// input. Registered by `modules/tenant-mcp.ts` only when the MCP layer is
// loaded. It has no scope: any valid bearer may list its own memberships,
// the same set the org switcher shows.
import { z } from 'zod'
import { defineMcpTool, getRegistry, mcpError, type McpToolDef } from '#mcp-layer'
import { adminDb } from '../server/utils/database-admin'
import { getOrgEnabledApps } from '../server/utils/app-settings'

export const listOrgsTool = defineMcpTool({
  name: 'list_orgs',
  title: 'List Organizations',
  description: 'List organizations the bearer is a member of. Returns each org\'s id, slug, name and `apps`: the apps switched on in that org that have MCP tools. Pass a slug as `org` to any other tool to operate in that org, and only call an app\'s tools in orgs whose `apps` include it.',
  input: z.object({}).strict(),
  handler: async (_input, ctx) => {
    try {
      const rows = await adminDb
        .selectFrom('memberships as m')
        .innerJoin('orgs as o', 'o.id', 'm.org_id')
        .select(['o.id', 'o.slug', 'o.name'])
        .where('m.user_id', '=', ctx.auth.userId)
        .orderBy('o.name', 'asc')
        .distinct()
        .execute()

      const mcpApps = new Set(getRegistry().tools.flatMap(t => t.def.appId ? [t.def.appId] : []))
      const orgs = []
      for (const row of rows) {
        const enabled = await getOrgEnabledApps(adminDb, row.id)
        orgs.push({ ...row, apps: [...enabled].filter(id => mcpApps.has(id)).sort() })
      }
      return {
        content: [{ type: 'text' as const, text: `${orgs.length} org(s).` }],
        structuredContent: { orgs }
      }
    } catch (err) { return mcpError(err) }
  }
})

export default defineNitroPlugin(() => {
  getRegistry().register(listOrgsTool as McpToolDef<unknown, unknown>)
})
