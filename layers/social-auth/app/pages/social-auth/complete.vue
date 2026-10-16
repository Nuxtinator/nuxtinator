<script setup lang="ts">
// Last step of a provider sign-in that couldn't finish on its own: a sign-up
// that arrived without a usable name (Apple sends it only once, and not at
// all if the user declines to share it), or an email that belongs to an
// account with a password, which must be entered once to link the provider.
definePageMeta({
  layout: 'auth'
})

const { checkAuth } = useAuth()

const { data: pending, error: pendingError } = await useFetch<{ provider: string, email: string | null, step: 'name' | 'password' }>('/api/social-auth/pending')

const isPasswordStep = computed(() => pending.value?.step === 'password')
const displayName = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

const canSubmit = computed(() => isPasswordStep.value ? password.value.length > 0 : displayName.value.trim().length >= 2)

async function submit() {
  error.value = ''
  if (!canSubmit.value) {
    error.value = isPasswordStep.value ? 'Password is required' : 'Name must be at least 2 characters'
    return
  }
  submitting.value = true
  try {
    const res = await $fetch<{ redirect: string }>('/api/social-auth/complete', {
      method: 'POST',
      body: isPasswordStep.value ? { password: password.value } : { display_name: displayName.value.trim() }
    })
    await checkAuth()
    await navigateTo(res.redirect || '/', { replace: true })
  } catch (err: any) {
    error.value = err?.data?.statusMessage || (isPasswordStep.value ? 'Could not link your account' : 'Could not finish signing up')
    password.value = ''
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
        {{ isPasswordStep ? 'Confirm it\'s your account' : 'What should we call you?' }}
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
          title="Your sign-in session has expired"
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
          v-if="isPasswordStep"
          class="text-sm text-(--ui-text-muted)"
        >
          An account for <strong>{{ pending?.email }}</strong> already exists. Enter its password once to sign in with {{ pending?.provider }} from now on.
        </p>
        <p
          v-else-if="pending?.email"
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
          v-if="isPasswordStep"
          label="Password"
          name="password"
          required
        >
          <UInput
            v-model="password"
            type="password"
            size="lg"
            autocomplete="current-password"
            autofocus
            class="w-full"
            :disabled="submitting"
          />
        </UFormField>
        <UFormField
          v-else
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
          :disabled="submitting || !canSubmit"
        >
          Continue
        </UButton>

        <p
          v-if="isPasswordStep"
          class="text-center text-sm text-(--ui-text-muted)"
        >
          Forgot it? <ULink
            to="/login"
            class="text-(--ui-primary) hover:underline"
          >Reset your password</ULink> from the sign-in page.
        </p>
      </form>
    </UCard>
  </div>
</template>
