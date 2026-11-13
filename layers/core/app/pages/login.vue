<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

const route = useRoute()
const { login } = useAuth()
const registrationOpen = await useRegistrationOpen()

const state = reactive({
  email: '',
  password: ''
})

const loading = ref(false)
const error = ref('')
const successMessage = ref('')

// Forgot password state
const view = ref<'login' | 'reset'>('login')
const resetEmail = ref('')
const resetLoading = ref(false)
const resetError = ref('')
const resetSuccess = ref(false)
const sentToEmail = ref('')

const redirectTarget = computed(() => typeof route.query.redirect === 'string' ? route.query.redirect : undefined)

// Check for verification status in query params
onMounted(() => {
  error.value = authErrorMessage(route.query.auth_error)

  const verified = route.query.verified as string
  if (verified === 'success') {
    successMessage.value = 'Email verified successfully! You can now sign in.'
  } else if (verified === 'already') {
    successMessage.value = 'Your email is already verified. Please sign in.'
  }
})

async function handleLogin() {
  error.value = ''
  loading.value = true

  try {
    const result = await login(state.email, state.password)

    if (!result.success) {
      error.value = result.message || 'Login failed. Please check your credentials.'
    }
    // On success, useAuth composable will handle navigation
  } catch (err: any) {
    error.value = err.data?.message || 'An error occurred during login. Please try again.'
  } finally {
    loading.value = false
  }
}

// The register page, carrying along where to go after signing in.
const registerLink = computed(() => ({
  path: '/register',
  query: redirectTarget.value ? { redirect: redirectTarget.value } : {}
}))

async function handleForgotPassword() {
  resetError.value = ''
  resetLoading.value = true

  try {
    const response = await $fetch('/api/auth/forgot-password', {
      method: 'POST',
      body: {
        email: resetEmail.value
      }
    })

    resetSuccess.value = true
    sentToEmail.value = resetEmail.value
    resetEmail.value = ''
  } catch (err: any) {
    resetError.value = err.data?.message || 'An error occurred. Please try again.'
  } finally {
    resetLoading.value = false
  }
}

function switchToLogin() {
  view.value = 'login'
  resetSuccess.value = false
  resetError.value = ''
  sentToEmail.value = ''
}

function switchToReset() {
  view.value = 'reset'
  error.value = ''
  successMessage.value = ''
}
</script>

<template>
  <AuthCard :title="view === 'login' ? 'Sign in' : 'Reset your password'">
    <!-- Login View -->
    <form
      v-if="view === 'login'"
      class="space-y-6"
      @submit.prevent="handleLogin"
    >
      <!-- Success Alert -->
      <UAlert
        v-if="successMessage"
        color="success"
        variant="soft"
        icon="i-lucide-circle-check"
        :title="successMessage"
        close
        @update:open="successMessage = ''"
      />

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

      <AuthProviderButtons
        intent="login"
        :redirect="redirectTarget"
        separator="or"
      />

      <div class="space-y-4">
        <!-- Email Input -->
        <UFormField
          label="Email"
          name="email"
          required
        >
          <UInput
            v-model="state.email"
            type="email"
            placeholder="you@example.com"
            size="lg"
            :disabled="loading"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <!-- Password Input -->
        <div class="relative">
          <UFormField
            label="Password"
            name="password"
            required
          >
            <UInput
              v-model="state.password"
              type="password"
              size="lg"
              :disabled="loading"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>

          <!-- Forgot Password Link: shown in the label row, placed after the input so Tab goes from email to password -->
          <UButton
            variant="link"
            color="neutral"
            class="absolute top-0 right-0 p-0"
            :disabled="loading"
            @click="switchToReset"
          >
            Forgot password?
          </UButton>
        </div>
      </div>

      <!-- Submit Button -->
      <UButton
        type="submit"
        color="primary"
        size="lg"
        block
        :loading="loading"
        :disabled="loading || !state.email || !state.password"
      >
        Sign in
      </UButton>
    </form>

    <!-- Forgot Password View -->
    <form
      v-else
      class="space-y-6"
      @submit.prevent="handleForgotPassword"
    >
      <!-- Success Message -->
      <div
        v-if="resetSuccess"
        class="space-y-4"
      >
        <UAlert
          color="success"
          variant="soft"
          icon="i-lucide-circle-check"
          title="Email sent"
          close
          @update:open="resetSuccess = false"
        />
        <p class="text-(--ui-text-muted)">
          If an account with <strong>{{ sentToEmail }}</strong> exists, you will receive password reset instructions shortly.
        </p>
        <p class="text-sm text-(--ui-text-dimmed)">
          Check your email inbox and spam folder.
        </p>
      </div>

      <!-- Reset Form -->
      <div
        v-else
        class="space-y-6"
      >
        <!-- Error Alert -->
        <UAlert
          v-if="resetError"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          :title="resetError"
          close
          @update:open="resetError = ''"
        />

        <!-- Email Input -->
        <UFormField
          label="Email"
          name="email"
          required
        >
          <UInput
            v-model="resetEmail"
            type="email"
            placeholder="you@example.com"
            size="lg"
            :disabled="resetLoading"
            autocomplete="email"
            class="w-full"
          />
        </UFormField>

        <!-- Submit Button -->
        <UButton
          type="submit"
          color="primary"
          size="lg"
          block
          :loading="resetLoading"
          :disabled="resetLoading || !resetEmail"
        >
          Send reset link
        </UButton>
      </div>
    </form>

    <template
      v-if="view === 'reset' || registrationOpen"
      #footer
    >
      <!-- Register Link -->
      <template v-if="view === 'login'">
        New here?
        <NuxtLink
          :to="registerLink"
          class="font-medium text-(--ui-text) underline underline-offset-4 decoration-(--ui-border-accented) hover:decoration-current transition-colors"
        >
          Create an account
        </NuxtLink>
      </template>

      <!-- Back to Login -->
      <UButton
        v-else
        variant="link"
        color="neutral"
        icon="i-lucide-arrow-left"
        class="p-0"
        :disabled="resetLoading"
        @click="switchToLogin"
      >
        Back to sign in
      </UButton>
    </template>

    <!-- Footer -->
    <template #note>
      By signing in, you agree to our Terms of Service and Privacy Policy
    </template>
  </AuthCard>
</template>
