<script setup lang="ts">
// Signed-in users belong on the launcher at /dashboard (in multi-tenant mode
// the tenancy route guard forwards that into the active org or the picker).
// The redirect runs as route middleware, before this page renders: navigating
// from setup during the app's first render can complete while the layout is
// still pending, leaving this page on screen under the new URL.
definePageMeta({
  middleware: [() => {
    if (useAuth().user.value) return navigateTo(launcherPath(), { replace: true })
  }]
})

const { user, authReady } = useAuth()
const config = useRuntimeConfig()
const registrationOpen = await useRegistrationOpen({ lazy: true })

// A sign-in that lands while this page is open.
watch([authReady, user], ([r, u]) => {
  if (r && u) navigateTo(launcherPath())
})
</script>

<template>
  <div>
    <div class="text-center py-16 px-4">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-4">
        {{ config.public.appName }}
      </h1>
      <template v-if="authReady && !user">
        <p class="text-(--ui-text-muted) mb-8 max-w-lg mx-auto">
          {{ registrationOpen ? 'Get started by signing in or creating an account.' : 'Sign in to get started.' }}
        </p>
        <div class="flex gap-3 justify-center">
          <UButton
            to="/login"
            color="primary"
            size="lg"
          >
            Sign in
          </UButton>
          <UButton
            v-if="registrationOpen"
            to="/register"
            color="neutral"
            variant="subtle"
            size="lg"
          >
            Create account
          </UButton>
        </div>
      </template>
    </div>
  </div>
</template>
