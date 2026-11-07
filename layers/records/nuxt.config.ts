// Records layer — the generic record kernel: record types and fields (code
// manifests merged with admin overrides), the storage-routed field pipeline,
// the list engine, sharing, comments, activity, the schema builder, and the
// /records app for browsing any type.
//
// Aliases:
//   #records        — shared manifest types, field-kind registry and client
//                     extension registries (client + server)
//   #records/client — client field settings, formatters and badge colors
//   #records/server — kernel server services for consumer layers
//
// The MCP tools in mcp/ are registered only when the MCP layer is loaded
// (modules/records-mcp.ts).
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/records-mcp.ts', import.meta.url))
  ],

  alias: {
    '#records': fileURLToPath(new URL('./app/utils/records-manifest.ts', import.meta.url)),
    '#records/client': fileURLToPath(new URL('./client/index.ts', import.meta.url)),
    // The barrel lives in server/exports/ (not server/utils/) so nitro's
    // auto-import scan doesn't see it — re-exporting names that are also
    // auto-imported from their source files would log "Duplicated imports".
    '#records/server': fileURLToPath(new URL('./server/exports/index.ts', import.meta.url))
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#records': [`${layerRoot}app/utils/records-manifest.ts`],
            '#records/server': [`${layerRoot}server/exports/index.ts`]
          }
        }
      }
    }
  }
})
