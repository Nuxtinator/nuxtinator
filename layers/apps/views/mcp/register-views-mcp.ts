// Registers the views MCP tools with the MCP-layer registry. Added by
// modules/views-mcp.ts only when the MCP layer is loaded.
//
// Re-registers the views permission first: the registry only accepts scopes
// already in the runtime permission registry, and Nitro plugin order doesn't
// guarantee register-views.ts ran before this. registerPermissions is
// idempotent.
import { getRegistry, type McpToolDef } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { VIEWS_PERMISSIONS, VIEWS_PERMISSION_META } from '../app/utils/permissions'
import { viewsMcpTools } from './views-tools'

export default defineNitroPlugin(() => {
  registerPermissions(VIEWS_PERMISSIONS, VIEWS_PERMISSION_META)

  const registry = getRegistry()
  for (const tool of viewsMcpTools) {
    registry.register(tool as McpToolDef<unknown, unknown>)
  }
})
