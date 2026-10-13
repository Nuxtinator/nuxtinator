<script setup lang="ts">
const { user, authReady } = useAuth()
const config = useRuntimeConfig()
const registrationOpen = await useRegistrationOpen()

// Multi-tenant mode bounces an authed user into their last-active org (or the
// org picker). Single-tenant mode has no orgs, so home is right here — show the
// launcher hint below instead of redirecting.
watch([authReady, user], ([r, u]) => {
  if (r && u && config.public.tenancy) {
    const cookie = useCookie<string | null>('active-org-slug')
    navigateTo(cookie.value ? `/@${cookie.value}/` : '/orgs')
  }
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
      <p
        v-else-if="authReady && user"
        class="text-(--ui-text-muted) max-w-lg mx-auto"
      >
        Choose an app from the menu to get started.
      </p>
    </div>
  </div>
</template>
