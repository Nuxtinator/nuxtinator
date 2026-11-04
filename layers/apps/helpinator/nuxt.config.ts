// Helpinator — an embeddable AI help chat. A site drops in one <script> tag;
// visitors chat with a bot grounded on ONE context portfolio (via the ai
// layer's OpenRouter backend), conversations are logged read-only for staff,
// and a visitor who still needs help is handed off to the shared inbox.
//
// Requires `@nuxtinator/context` + `@nuxtinator/ai`. `@nuxtinator/inbox` is
// optional: modules/inbox-bridge.ts points `#helpinator/inbox` at a real
// adapter when inbox is loaded, and at a stub otherwise (handoff disabled).
//
// The widget bundle (embeddables/helpinator-widget) builds into this layer's
// public/js/ and is served at /js/helpinator-widget.iife.js by any host.
import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: [
    fileURLToPath(new URL('./modules/inbox-bridge.ts', import.meta.url))
  ],

  runtimeConfig: {
    // Library chunks are pgvector columns; without the extension core's
    // migration runner skips helpinator_* migrations and warns.
    migrationRequiredExtensions: { helpinator: ['vector'] },
    // Scheduled website-library re-sync (server/plugins/helpinator-sync-sweep.ts):
    // how often to check, and how old a source's last sync must be to re-crawl.
    helpinatorSyncCron: process.env.HELPINATOR_SYNC_CRON || '0 2 * * *',
    helpinatorSyncMaxAgeDays: Number(process.env.HELPINATOR_SYNC_MAX_AGE_DAYS) || 7
  },

  vue: {
    compilerOptions: {
      // The admin widget page previews the real web component.
      isCustomElement: (tag: string) => tag === 'helpinator-widget'
    }
  }
})
