// CRM layer — the contacts app on top of the records kernel: the contacts
// record type, communication channels (address identities shared across
// records), consent per channel and purpose, suppression, and the contacts
// UI. Requires @nuxtinator/records.
//
// Aliases:
//   #crm        — shared crm types (client + server)
//   #crm/server — channel, consent and suppression services for consumer
//                 layers (email inbox, marketing, forms)
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
    '#crm': fileURLToPath(new URL('./app/utils/crm.ts', import.meta.url)),
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
            '#crm': [`${layerRoot}app/utils/crm.ts`],
            '#crm/server': [`${layerRoot}server/exports/index.ts`]
          }
        }
      }
    }
  }
})
