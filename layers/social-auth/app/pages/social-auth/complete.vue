<script setup lang="ts">
// Last step of a provider sign-up that arrived without a usable name (Apple
// sends it only once, and not at all if the user declines to share it).
definePageMeta({
  layout: 'auth'
})

const { checkAuth } = useAuth()

const { data: pending, error: pendingError } = await useFetch<{ provider: string, email: string | null }>('/api/social-auth/pending')

const displayName = ref('')
const submitting = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  if (displayName.value.trim().length < 2) {
    error.value = 'Name must be at least 2 characters'
    return
  }
  submitting.value = true
  try {
    const res = await $fetch<{ redirect: string }>('/api/social-auth/complete', {
      method: 'POST',
      body: { display_name: displayName.value.trim() }
    })
    await checkAuth()
    await navigateTo(res.redirect || launcherPath(), { replace: true })
  } catch (err: any) {
    error.value = err?.data?.statusMessage || 'Could not finish signing up'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-2">
        One more step
      </h1>
      <p class="text-(--ui-text-muted)">
        What should we call you?
      </p>
    </div>

    <UCard :ui="{ body: 'p-6 sm:p-8' }">
      <div
        v-if="pendingError"
        class="space-y-4"
      >
        <UAlert
          color="error"
          variant="soft"
          title="Your sign-up session has expired"
        />
        <UButton
          to="/login"
          size="lg"
          block
        >
          Back to Sign In
        </UButton>
      </div>

      <form
        v-else
        class="space-y-6"
        @submit.prevent="submit"
      >
        <p
          v-if="pending?.email"
          class="text-sm text-(--ui-text-muted)"
        >
          Signing up with {{ pending.provider }} as <strong>{{ pending.email }}</strong>.
        </p>

        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
        />

        <UFormField
          label="Your name"
          name="display_name"
          required
        >
          <UInput
            v-model="displayName"
            size="lg"
            autocomplete="name"
            autofocus
            class="w-full"
            :disabled="submitting"
          />
        </UFormField>

        <UButton
          type="submit"
          size="lg"
          block
          :loading="submitting"
          :disabled="submitting || displayName.trim().length < 2"
        >
          Continue
        </UButton>
      </form>
    </UCard>
  </div>
</template>
