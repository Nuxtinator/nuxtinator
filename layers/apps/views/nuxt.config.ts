// Views layer — user-created kanban boards and tables over record types.
// No aliases of its own: cross-layer imports go through #records,
// #records/client, #records/server, #core and #tenant, all provided by the
// layers this one depends on.
//
// The MCP tools in mcp/ are registered only when the MCP layer is loaded
// (modules/views-mcp.ts).
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/views-mcp.ts', import.meta.url))
  ]
})
