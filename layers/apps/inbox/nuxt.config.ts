// Inbox layer — two-way shared email inbox built on the CRM layer's channel
// kernel. Conversations key on crm_channels (the address registry). Mail goes
// through core's mail kernel on the `inbox` stream: inbound mail arrives
// through the kernel's provider webhooks and the inbox's inbound handler,
// outbound replies ride a croner-swept queue on inbox_messages itself.
//
// The layer imports CRM kernel services from `#crm/server` (registered by the
// crm layer's own nuxt.config; aliases merge across extends:).
//
// `#inbox` is the client registry for extra conversation menu actions
// (app/utils/inbox-thread-actions.ts), for hosts and other layers.
//
// `#inbox/server` exposes the conversation-creation + channel-claim primitives
// so a future forms layer can create inbox conversations without reaching into
// this layer's file layout. The barrel lives in server/exports/ (not
// server/utils/) so nitro's auto-import scan doesn't double-import the names.
//
// The MCP tools in mcp/ are registered only when the MCP layer is loaded
// (modules/inbox-mcp.ts).
import { fileURLToPath } from 'node:url'

const layerRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/inbox-mcp.ts', import.meta.url))
  ],

  alias: {
    '#inbox': fileURLToPath(new URL('./app/utils/inbox-thread-actions.ts', import.meta.url)),
    '#inbox/server': fileURLToPath(new URL('./server/exports/index.ts', import.meta.url))
  },

  nitro: {
    typescript: {
      tsConfig: {
        compilerOptions: {
          paths: {
            '#inbox/server': [`${layerRoot}server/exports/index.ts`]
          }
        }
      }
    }
  },

  runtimeConfig: {
    // Send-sweep cadence in seconds. Tests lower it to make queued sends
    // observable quickly.
    inboxSendSweepSeconds: process.env.INBOX_SEND_SWEEP_SECONDS || '20',
    // Cron for the daily AI grounding sync (UTC). Default 03:00.
    inboxGroundingSyncCron: process.env.INBOX_GROUNDING_SYNC_CRON || '0 3 * * *',
    // Cron for the daily auto-close of quiet pending conversations (UTC).
    // Default 04:00; the per-org quiet threshold lives in inbox settings.
    inboxAutoCloseCron: process.env.INBOX_AUTO_CLOSE_CRON || '0 4 * * *'
  }
})
