// Registers the inbox MCP tools with the MCP-layer registry. Added by
// modules/inbox-mcp.ts only when the MCP layer is loaded.
//
// Re-registers the inbox permissions first: the registry only accepts scopes
// already in the runtime permission registry, and Nitro plugin order doesn't
// guarantee register-inbox.ts ran before this. registerPermissions is
// idempotent.
import { getRegistry, type McpToolDef } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { INBOX_PERMISSIONS, INBOX_PERMISSION_META } from '../app/utils/permissions'
import { inboxMcpTools } from './inbox-tools'

export default defineNitroPlugin(() => {
  registerPermissions(INBOX_PERMISSIONS, INBOX_PERMISSION_META)

  const registry = getRegistry()
  for (const tool of inboxMcpTools) {
    registry.register(tool as McpToolDef<unknown, unknown>)
  }
})
