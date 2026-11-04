// CRM layer — generic record kernel + the contacts record type + default CRM UI.
//
// Aliases:
//   #crm        — shared manifest types + field-kind registry (client + server)
//   #crm/server — kernel server services (record CRUD, channels, consent) for
//                 consumer layers (email inbox, marketing, forms)
//
// The MCP tools in mcp/ are registered only when the MCP layer is loaded
// (modules/crm-mcp.ts).
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/crm-mcp.ts', import.meta.url))
  ],

  alias: {
    '#crm': fileURLToPath(new URL('./app/utils/crm-manifest.ts', import.meta.url)),
    // The barrel lives in server/exports/ (not server/utils/) so nitro's
    // auto-import scan doesn't see it — re-exporting names that are also
    // auto-imported from their source files would log "Duplicated imports".
    '#crm/server': fileURLToPath(new URL('./server/exports/index.ts', import.meta.url))
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#crm': [`${layerRoot}app/utils/crm-manifest.ts`],
            '#crm/server': [`${layerRoot}server/exports/index.ts`]
          }
        }
      }
    }
  }
})
