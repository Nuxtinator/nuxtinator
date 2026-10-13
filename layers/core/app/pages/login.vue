<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

const router = useRouter()
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

const redirectToRegister = () => {
  const redirect = route.query.redirect as string
  if (redirect) {
    router.push(`/register?redirect=${encodeURIComponent(redirect)}`)
  } else {
    router.push('/register')
  }
}

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
  <div>
    <!-- Logo/Header -->
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-2">
        {{ view === 'login' ? 'Welcome Back' : 'Reset Password' }}
      </h1>
      <p class="text-(--ui-text-muted)">
        {{ view === 'login' ? 'Sign in to your account' : 'Enter your email to receive reset instructions' }}
      </p>
    </div>

    <!-- Login View -->
    <UCard
      v-if="view === 'login'"
      :ui="{ body: 'p-6 sm:p-8' }"
    >
      <form
        class="space-y-6"
        @submit.prevent="handleLogin"
      >
        <!-- Success Alert -->
        <UAlert
          v-if="successMessage"
          color="success"
          variant="soft"
          :title="successMessage"
          :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
          @close="successMessage = ''"
        />

        <!-- Error Alert -->
        <UAlert
          v-if="error"
          color="error"
          variant="soft"
          :title="error"
          :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
          @close="error = ''"
        />

        <AuthProviderButtons
          intent="login"
          :redirect="redirectTarget"
          separator="or"
        />

        <!-- Email Input -->
        <div class="space-y-2">
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
        </div>

        <!-- Password Input -->
        <div class="space-y-2">
          <UFormField
            label="Password"
            name="password"
            required
          >
            <UInput
              v-model="state.password"
              type="password"
              placeholder="Enter your password"
              size="lg"
              :disabled="loading"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>
        </div>

        <!-- Forgot Password Link -->
        <div class="text-right">
          <button
            type="button"
            class="text-sm text-(--ui-text-muted) hover:text-(--ui-text) transition-colors"
            :disabled="loading"
            @click="switchToReset"
          >
            Forgot Password?
          </button>
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
          Sign In
        </UButton>

        <template v-if="registrationOpen">
          <!-- Divider -->
          <div class="relative">
            <div class="absolute inset-0 flex items-center">
              <div class="w-full border-t border-(--ui-border)" />
            </div>
            <div class="relative flex justify-center text-sm">
              <span class="px-2 bg-(--ui-bg) text-(--ui-text-muted)">Don't have an account?</span>
            </div>
          </div>

          <!-- Register Link -->
          <UButton
            color="neutral"
            variant="outline"
            size="lg"
            block
            :disabled="loading"
            @click="redirectToRegister"
          >
            Create Account
          </UButton>
        </template>
      </form>
    </UCard>

    <!-- Forgot Password View -->
    <UCard
      v-else
      :ui="{ body: 'p-6 sm:p-8' }"
    >
      <form
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
            title="Email Sent!"
            :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
            @close="resetSuccess = false"
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
            :title="resetError"
            :close-button="{ icon: 'i-lucide-x', color: 'gray', variant: 'ghost' }"
            @close="resetError = ''"
          />

          <!-- Email Input -->
          <div class="space-y-2">
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
          </div>

          <!-- Submit Button -->
          <UButton
            type="submit"
            color="primary"
            size="lg"
            block
            :loading="resetLoading"
            :disabled="resetLoading || !resetEmail"
          >
            Send Reset Link
          </UButton>
        </div>

        <!-- Back to Login -->
        <div class="text-center">
          <button
            type="button"
            class="text-sm text-(--ui-text-muted) hover:text-(--ui-text) transition-colors"
            :disabled="resetLoading"
            @click="switchToLogin"
          >
            ← Back to Login
          </button>
        </div>
      </form>
    </UCard>

    <!-- Footer -->
    <p class="text-center text-sm text-(--ui-text-dimmed) mt-8">
      By signing in, you agree to our Terms of Service and Privacy Policy
    </p>
  </div>
</template>
