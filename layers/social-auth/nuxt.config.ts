// Sign in with Google and Sign in with Apple. Each provider turns on when its
// env vars are set; with neither configured the layer is inert. See README.md.
export default defineNuxtConfig({
  runtimeConfig: {
    socialAuth: {
      google: {
        // Web OAuth client (NUXT_SOCIAL_AUTH_GOOGLE_CLIENT_ID / _CLIENT_SECRET).
        clientId: '',
        clientSecret: '',
        // Comma-separated iOS/Android client IDs whose ID tokens native apps
        // may send (NUXT_SOCIAL_AUTH_GOOGLE_NATIVE_CLIENT_IDS).
        nativeClientIds: '',
        // Overrides Google's signing-key URL; only for tests and emulators.
        jwksUrl: '',
        // Comma-separated hosts profile photos may come from; empty means
        // googleusercontent.com (NUXT_SOCIAL_AUTH_GOOGLE_PHOTO_HOSTS).
        photoHosts: ''
      },
      apple: {
        // Services ID used by the web flow (NUXT_SOCIAL_AUTH_APPLE_SERVICES_ID).
        servicesId: '',
        teamId: '',
        keyId: '',
        // Contents of the .p8 key; literal "\n" sequences are accepted.
        privateKey: '',
        // Comma-separated app bundle IDs whose ID tokens native apps may send
        // (NUXT_SOCIAL_AUTH_APPLE_BUNDLE_IDS).
        bundleIds: '',
        // Overrides Apple's signing-key URL; only for tests and emulators.
        jwksUrl: ''
      }
    }
  }
})
