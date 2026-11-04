export default defineNuxtConfig({
  vue: {
    compilerOptions: {
      isCustomElement: (tag: string) => tag === 'feedback-web-component'
    }
  },

  // The widget sign-in approval page must not be framed by the embedding site.
  routeRules: {
    '/feedback/connect': {
      headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': 'frame-ancestors \'none\'' }
    }
  },

  // This layer owns its own config — the host no longer declares this.
  runtimeConfig: {
    // Lifetime of the access token minted for the embeddable widget
    // (jsonwebtoken duration string). Long-lived to avoid frequent re-auth
    // redirects on third-party pages. Override at runtime with
    // NUXT_FEEDBACK_TOKEN_TTL — no rebuild needed.
    feedbackTokenTtl: process.env.FEEDBACK_TOKEN_TTL || '30d',
    public: {
      feedbackProjectId: process.env.NUXT_PUBLIC_FEEDBACK_PROJECT_ID || process.env.FEEDBACK_PROJECT_ID || ''
    }
  }
})
