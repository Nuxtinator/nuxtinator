// Registers the test fixture's MCP tools with the registry. Order across
// layers isn't strictly defined, so we go through the module-level
// singleton (`getRegistry()`) rather than `nitroApp.mcpRegistry` to avoid
// a flaky undefined-on-cold-start.
import { getRegistry } from '#mcp-layer'
import { registerPermissions } from '#core/server/utils/permissions-registry'
import { registerStaticRole } from '#core/server/utils/roles-registry'
import {
  listPagesTool,
  createPageTool,
  deletePageTool,
  outputCheckTool,
  expensiveTool,
  failingTool
} from '../mcp-tools/all'

const PAGE_PERMISSIONS = ['pages.view', 'pages.write', 'pages.publish']

// Roles the harness assigns via `users.roles`; `admin` is core's built-in
// union of every registered permission.
const ROLES: Record<string, string[]> = {
  reader: ['pages.view'],
  writer: ['pages.view', 'pages.write'],
  publisher: ['pages.view', 'pages.write', 'pages.publish']
}

export default defineNitroPlugin(() => {
  registerPermissions(PAGE_PERMISSIONS)
  for (const [key, permissions] of Object.entries(ROLES)) {
    registerStaticRole({ key, name: key, description: key, permissions, source: 'mcp-fixture' })
  }

  const registry = getRegistry()
  registry.register(listPagesTool)
  registry.register(createPageTool)
  registry.register(deletePageTool)
  registry.register(outputCheckTool)
  registry.register(expensiveTool)
  registry.register(failingTool)
})
