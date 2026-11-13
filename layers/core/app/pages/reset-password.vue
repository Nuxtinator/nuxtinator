<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

const router = useRouter()
const route = useRoute()

const token = computed(() => route.query.token as string)

const state = reactive({
  password: '',
  confirmPassword: '',
  loading: false
})

const error = ref('')
const success = ref(false)
const invalidToken = ref(false)

// Validate token on mount
onMounted(() => {
  if (!token.value) {
    invalidToken.value = true
  }
})

async function handleResetPassword() {
  error.value = ''

  // Validate passwords
  if (state.password.length < 6) {
    error.value = 'Password must be at least 6 characters'
    return
  }

  if (state.password !== state.confirmPassword) {
    error.value = 'Passwords do not match'
    return
  }

  state.loading = true

  try {
    const response = await $fetch('/api/auth/reset-password', {
      method: 'POST',
      body: {
        token: token.value,
        password: state.password,
        confirmPassword: state.confirmPassword
      }
    })

    success.value = true

    // Redirect to login after 2 seconds
    setTimeout(() => {
      router.push('/login')
    }, 2000)
  } catch (err: any) {
    error.value = err.data?.message || 'An error occurred. Please try again.'
  } finally {
    state.loading = false
  }
}
</script>

<template>
  <AuthCard title="Set a new password">
    <!-- Invalid Token View -->
    <div
      v-if="invalidToken"
      class="space-y-4"
    >
      <UAlert
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        title="Invalid reset link"
      />
      <p class="text-(--ui-text-muted)">
        This password reset link is invalid or has expired. Please request a new password reset.
      </p>
      <UButton
        color="primary"
        size="lg"
        block
        @click="router.push('/login')"
      >
        Back to sign in
      </UButton>
    </div>

    <!-- Success View -->
    <div
      v-else-if="success"
      class="space-y-4"
    >
      <UAlert
        color="success"
        variant="soft"
        icon="i-lucide-circle-check"
        title="Password reset"
      />
      <p class="text-(--ui-text-muted)">
        Your password has been reset. You can now sign in with your new password.
      </p>
      <p class="text-sm text-(--ui-text-dimmed)">
        Taking you to sign in…
      </p>
    </div>

    <!-- Reset Form -->
    <form
      v-else
      class="space-y-6"
      @submit.prevent="handleResetPassword"
    >
      <!-- Error Alert -->
      <UAlert
        v-if="error"
        color="error"
        variant="soft"
        icon="i-lucide-circle-alert"
        :title="error"
        close
        @update:open="error = ''"
      />

      <div class="space-y-4">
        <!-- Password Input -->
        <UFormField
          label="New password"
          name="password"
          required
        >
          <UInput
            v-model="state.password"
            type="password"
            placeholder="At least 6 characters"
            size="lg"
            :disabled="state.loading"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>

        <!-- Confirm Password Input -->
        <UFormField
          label="Confirm password"
          name="confirmPassword"
          required
        >
          <UInput
            v-model="state.confirmPassword"
            type="password"
            size="lg"
            :disabled="state.loading"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
      </div>

      <!-- Submit Button -->
      <UButton
        type="submit"
        color="primary"
        size="lg"
        block
        :loading="state.loading"
        :disabled="state.loading || !state.password || !state.confirmPassword"
      >
        Reset password
      </UButton>
    </form>

    <!-- Back to Login -->
    <template
      v-if="!invalidToken && !success"
      #footer
    >
      <UButton
        variant="link"
        color="neutral"
        icon="i-lucide-arrow-left"
        class="p-0"
        :disabled="state.loading"
        to="/login"
      >
        Back to sign in
      </UButton>
    </template>

    <!-- Footer -->
    <template #note>
      By resetting your password, you agree to our Terms of Service and Privacy Policy
    </template>
  </AuthCard>
</template>
