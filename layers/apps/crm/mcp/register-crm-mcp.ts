// Registers the CRM MCP tools with the MCP-layer registry. Added by
// modules/crm-mcp.ts only when the MCP layer is loaded.
//
// Re-registers the CRM permissions first: the registry only accepts scopes
// already in the runtime permission registry, and Nitro plugin order doesn't
// guarantee register-crm.ts ran before this. registerPermissions is
// idempotent.
import { getRegistry, type McpToolDef } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { CRM_PERMISSIONS, CRM_PERMISSION_META } from '../app/utils/permissions'
import { crmMcpTools } from './crm-tools'

export default defineNitroPlugin(() => {
  registerPermissions(CRM_PERMISSIONS, CRM_PERMISSION_META)

  const registry = getRegistry()
  for (const tool of crmMcpTools) {
    registry.register(tool as McpToolDef<unknown, unknown>)
  }
})
