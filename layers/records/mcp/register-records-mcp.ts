// Registers the records MCP tools with the MCP-layer registry. Added by
// modules/records-mcp.ts only when the MCP layer is loaded.
//
// Re-registers the records permissions first: the registry only accepts scopes
// already in the runtime permission registry, and Nitro plugin order doesn't
// guarantee register-records.ts ran before this. registerPermissions is
// idempotent.
import { getRegistry, type McpToolDef } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { RECORDS_PERMISSIONS, RECORDS_PERMISSION_META } from '../app/utils/permissions'
import { recordsMcpTools } from './records-tools'

export default defineNitroPlugin(() => {
  registerPermissions(RECORDS_PERMISSIONS, RECORDS_PERMISSION_META)

  const registry = getRegistry()
  for (const tool of recordsMcpTools) {
    registry.register(tool as McpToolDef<unknown, unknown>)
  }
})
