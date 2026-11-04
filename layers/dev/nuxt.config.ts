// Dev tooling layer. Holds UI sandboxes, demo pages, and utilities that
// shouldn't ship to production. Comment out from `extends:` for prod builds.
export default defineNuxtConfig({
  i18n: {
    locales: [
      { code: 'en', file: 'en.json' },
      { code: 'fr', language: 'fr', name: 'Français', file: 'fr.json' }
    ]
  }
})
