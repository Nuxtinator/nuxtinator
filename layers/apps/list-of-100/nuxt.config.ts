export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      // Personal app (see core's personal-apps.ts): its pages stay at this
      // path in every org.
      personalApps: { 'list-of-100': '/list-of-100' }
    }
  }
})
