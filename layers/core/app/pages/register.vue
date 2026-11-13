<script setup lang="ts">
definePageMeta({
  layout: 'auth'
})

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
        await navigateTo(launcherPath(), { replace: true })
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

// The sign-in page, carrying along where to go after signing in.
const loginLink = computed(() => ({
  path: '/login',
  query: redirectTarget.value ? { redirect: redirectTarget.value } : {}
}))
</script>

<template>
  <div>
    <!-- Register Card -->
    <AuthCard title="Create account">
      <!-- Success Message -->
      <div
        v-if="success"
        class="space-y-4"
      >
        <UAlert
          color="success"
          variant="soft"
          icon="i-lucide-circle-check"
          title="Registration successful"
          description="Please check your email to verify your account."
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
          :to="loginLink"
        >
          Back to sign in
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

        <!-- Display Name Input -->
        <div class="space-y-2">
          <UFormField
            label="Display name"
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
            label="Confirm password"
            name="confirmPassword"
            required
          >
            <UInput
              v-model="state.confirmPassword"
              type="password"
              size="lg"
              :disabled="loading"
              autocomplete="new-password"
              :ui="{ base: 'px-3 py-2' }"
              :color="!passwordMatch ? 'error' : undefined"
              class="w-full"
            />
            <p
              v-if="!passwordMatch"
              class="text-xs text-(--ui-error) mt-1"
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
          Create account
        </UButton>
      </form>

      <!-- Login Link -->
      <template
        v-if="!success && registrationOpen"
        #footer
      >
        Already have an account?
        <NuxtLink
          :to="loginLink"
          class="font-medium text-(--ui-text) underline underline-offset-4 decoration-(--ui-border-accented) hover:decoration-current transition-colors"
        >
          Sign in
        </NuxtLink>
      </template>

      <!-- Footer -->
      <template #note>
        By creating an account, you agree to our Terms of Service and Privacy Policy
      </template>
    </AuthCard>
  </div>
</template>
