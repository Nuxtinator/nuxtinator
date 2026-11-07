// Registers the crm MCP tools with the MCP-layer registry. Added by
// modules/crm-mcp.ts only when the MCP layer is loaded.
//
// Re-registers the records permissions first: the registry only accepts
// scopes already in the runtime permission registry, and Nitro plugin order
// doesn't guarantee the records layer's plugins ran before this.
// registerPermissions is idempotent.
import { getRegistry, type McpToolDef } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { RECORDS_PERMISSIONS, RECORDS_PERMISSION_META } from '#records'
import { crmMcpTools } from './crm-tools'

export default defineNitroPlugin(() => {
  registerPermissions(RECORDS_PERMISSIONS, RECORDS_PERMISSION_META)

  const registry = getRegistry()
  for (const tool of crmMcpTools) {
    registry.register(tool as McpToolDef<unknown, unknown>)
  }
})
