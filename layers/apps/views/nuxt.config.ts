// Views layer — user-created kanban boards and tables over record types,
// plus built-in views declared in code.
//
// Aliases:
//   #views/server — registerBuiltInView for layers that declare built-in views
//
// The MCP tools in mcp/ are registered only when the MCP layer is loaded
// (modules/views-mcp.ts).
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/views-mcp.ts', import.meta.url))
  ],

  alias: {
    '#views/server': fileURLToPath(new URL('./server/exports/index.ts', import.meta.url))
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#views/server': [`${layerRoot}server/exports/index.ts`]
          }
        }
      }
    }
  }
})
