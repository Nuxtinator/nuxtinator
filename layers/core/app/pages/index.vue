<script setup lang="ts">
const { user, authReady } = useAuth()
const config = useRuntimeConfig()

// Signed-in users belong on the launcher at /dashboard (in multi-tenant mode
// the tenancy route guard forwards that into the active org or the picker).
watch([authReady, user], ([r, u]) => {
  if (r && u) navigateTo(launcherPath())
}, { immediate: true })
</script>

<template>
  <div>
    <div class="text-center py-16 px-4">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-4">
        {{ config.public.appName }}
      </h1>
      <template v-if="authReady && !user">
        <p class="text-(--ui-text-muted) mb-8 max-w-lg mx-auto">
          Get started by signing in or creating an account.
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
