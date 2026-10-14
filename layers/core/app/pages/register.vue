<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

const router = useRouter()
const route = useRoute()
const { register } = useAuth()
const registrationOpen = await useRegistrationOpen()

const state = reactive({
  display_name: '',
  email: '',
  password: '',
  confirmPassword: ''
})

const loading = ref(false)
const error = ref(authErrorMessage(route.query.auth_error))
const success = ref(false)

const redirectTarget = computed(() => typeof route.query.redirect === 'string' ? route.query.redirect : undefined)

const passwordMatch = computed(() => {
  if (!state.confirmPassword) return true
  return state.password === state.confirmPassword
})

const passwordStrength = computed(() => {
  const password = state.password
  if (!password) return { strength: 0, label: '', color: 'gray' }

  let strength = 0
  if (password.length >= 8) strength++
  if (password.length >= 12) strength++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) strength++
  if (/\d/.test(password)) strength++
  if (/[^a-zA-Z0-9]/.test(password)) strength++

  const labels = ['Weak', 'Fair', 'Good', 'Strong', 'Very Strong']
  const colors = ['red', 'orange', 'yellow', 'green', 'emerald']

  return {
    strength: (strength / 5) * 100,
    label: labels[strength - 1] || 'Weak',
    color: colors[strength - 1] || 'red'
  }
})

async function handleRegister() {
  error.value = ''

  // Validation
  if (state.display_name.length < 2) {
    error.value = 'Display name must be at least 2 characters long'
    return
  }

  if (state.password.length < 8) {
    error.value = 'Password must be at least 8 characters long'
    return
  }

  if (state.password !== state.confirmPassword) {
    error.value = 'Passwords do not match'
    return
  }

  loading.value = true

  try {
    const result = await register(state.email, state.password, state.display_name) as { success: boolean, message?: string, autoLoggedIn?: boolean }

    if (result.success) {
      // First user is auto-logged-in by the server; skip the "check your email" UI.
      if (result.autoLoggedIn) {
        await navigateTo('/dashboard', { replace: true })
        return
      }
      success.value = true
    } else {
      error.value = result.message || 'Registration failed. Please try again.'
    }
  } catch (err: any) {
    error.value = err.data?.message || 'An error occurred during registration. Please try again.'
  } finally {
    loading.value = false
  }
}

const redirectToLogin = () => {
  const redirect = route.query.redirect as string
  if (redirect) {
    router.push(`/login?redirect=${encodeURIComponent(redirect)}`)
  } else {
    router.push('/login')
  }
}
</script>

<template>
  <div>
    <!-- Logo/Header -->
    <div class="text-center mb-8">
      <h1 class="text-4xl font-bold text-(--ui-text) mb-2">
        Create Account
      </h1>
      <p class="text-(--ui-text-muted)">
        Join us today
      </p>
    </div>

    <!-- Register Card -->
    <UCard :ui="{ body: 'p-6 sm:p-8' }">
      <!-- Success Message -->
      <div
        v-if="success"
        class="space-y-4"
      >
        <UAlert
          color="success"
          variant="soft"
          title="Registration Successful!"
          description="Please check your email to verify your account."
          :ui="{ icon: 'i-lucide-check-circle' }"
        />
      </div>

      <div
        v-else-if="!registrationOpen"
        class="space-y-6"
      >
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-lock"
          title="Registration is closed"
          description="New accounts can only be created from an invitation."
        />
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          block
          @click="redirectToLogin"
        >
          Back to Sign In
        </UButton>
      </div>

      <!-- Registration Form -->
      <form
        v-else
        class="space-y-6"
        @submit.prevent="handleRegister"
      >
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

        <!-- Display Name Input -->
        <div class="space-y-2">
          <UFormField
            label="Display Name"
            name="display_name"
            required
          >
            <UInput
              v-model="state.display_name"
              type="text"
              placeholder="Your name"
              size="lg"
              :disabled="loading"
              autocomplete="name"
              class="w-full"
            />
          </UFormField>
        </div>

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
              placeholder="Create a strong password"
              size="lg"
              :disabled="loading"
              autocomplete="new-password"
              class="w-full"
            />

            <!-- Password Strength Indicator -->
            <div
              v-if="state.password"
              class="mt-2 space-y-1"
            >
              <div class="flex items-center justify-between text-xs">
                <span class="text-(--ui-text-muted)">Password strength:</span>
                <span :class="`font-medium text-${passwordStrength.color}-600`">
                  {{ passwordStrength.label }}
                </span>
              </div>
              <div class="h-1.5 bg-(--ui-bg-accented) rounded-full overflow-hidden">
                <div
                  :class="`h-full bg-${passwordStrength.color}-500 transition-all duration-300`"
                  :style="{ width: `${passwordStrength.strength}%` }"
                />
              </div>
            </div>
          </UFormField>
        </div>

        <!-- Confirm Password Input -->
        <div class="space-y-2">
          <UFormField
            label="Confirm Password"
            name="confirmPassword"
            required
          >
            <UInput
              v-model="state.confirmPassword"
              type="password"
              placeholder="Confirm your password"
              size="lg"
              :disabled="loading"
              autocomplete="new-password"
              :ui="{ base: 'px-3 py-2' }"
              :color="!passwordMatch ? 'error' : undefined"
              class="w-full"
            />
            <p
              v-if="!passwordMatch"
              class="text-xs text-red-600 mt-1"
            >
              Passwords do not match
            </p>
          </UFormField>
        </div>

        <!-- Submit Button -->
        <UButton
          type="submit"
          color="primary"
          size="lg"
          block
          :loading="loading"
          :disabled="loading || !state.email || !state.password || !state.display_name || !passwordMatch"
        >
          Create Account
        </UButton>

        <!-- Divider -->
        <USeparator
          label="Already have an account?"
          :ui="{ container: 'font-normal text-muted' }"
        />

        <!-- Login Link -->
        <UButton
          color="neutral"
          variant="outline"
          size="lg"
          block
          :disabled="loading"
          @click="redirectToLogin"
        >
          Sign In
        </UButton>
      </form>
    </UCard>

    <!-- Footer -->
    <p class="text-center text-sm text-(--ui-text-dimmed) mt-8">
      By creating an account, you agree to our Terms of Service and Privacy Policy
    </p>
  </div>
</template>
