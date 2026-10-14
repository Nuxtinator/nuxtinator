<script setup lang="ts">
// Account card: change the password, or set one on a provider-only account.
const { user, checkAuth } = useAuth()
const { withReauth } = useReauth()

const hasPassword = computed(() => user.value?.has_password !== false)

const passwordState = reactive({
  current_password: '',
  new_password: '',
  confirm_password: ''
})
const passwordLoading = ref(false)
const passwordError = ref('')
const passwordSuccess = ref('')

// Password validation
const passwordMatch = computed(() => {
  return passwordState.new_password === passwordState.confirm_password
})

const passwordStrength = computed(() => {
  const password = passwordState.new_password
  if (password.length === 0) return { strength: 0, label: '', color: 'gray' }
  if (password.length < 8) return { strength: 25, label: 'Weak', color: 'red' }
  if (password.length < 12) return { strength: 50, label: 'Fair', color: 'yellow' }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return { strength: 50, label: 'Fair', color: 'yellow' }
  }
  return { strength: 100, label: 'Strong', color: 'green' }
})

const canSubmitPassword = computed(() => {
  return (passwordState.current_password || !hasPassword.value)
    && passwordState.new_password.length >= 8
    && passwordMatch.value
    && !passwordLoading.value
})

// Handle password change
async function handlePasswordChange() {
  passwordError.value = ''
  passwordSuccess.value = ''

  if (!canSubmitPassword.value) {
    return
  }

  passwordLoading.value = true

  try {
    await withReauth(() => $fetch('/api/profile/password', {
      method: 'PATCH',
      body: {
        ...(hasPassword.value ? { current_password: passwordState.current_password } : {}),
        new_password: passwordState.new_password
      }
    }))

    passwordSuccess.value = hasPassword.value ? 'Password changed successfully' : 'Password set'
    await checkAuth()

    // Reset form
    passwordState.current_password = ''
    passwordState.new_password = ''
    passwordState.confirm_password = ''
  } catch (err: any) {
    passwordError.value = err.data?.statusMessage || 'Failed to change password'
  } finally {
    passwordLoading.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        {{ hasPassword ? 'Change Password' : 'Set a Password' }}
      </h2>
    </template>
    <form
      class="space-y-4"
      @submit.prevent="handlePasswordChange"
    >
      <p
        v-if="!hasPassword"
        class="text-sm text-(--ui-text-muted)"
      >
        Add a password so you can also sign in with your email address.
      </p>
      <UFormField
        v-if="hasPassword"
        label="Current Password"
      >
        <UInput
          v-model="passwordState.current_password"
          type="password"
          size="lg"
          :disabled="passwordLoading"
          placeholder="Enter current password"
          autocomplete="current-password"
        />
      </UFormField>
      <UFormField label="New Password">
        <UInput
          v-model="passwordState.new_password"
          type="password"
          size="lg"
          :disabled="passwordLoading"
          placeholder="Enter new password (min 8 characters)"
          autocomplete="new-password"
        />
      </UFormField>
      <!-- Password Strength Indicator -->
      <div
        v-if="passwordState.new_password"
        class="space-y-2"
      >
        <div class="flex justify-between text-sm">
          <span>Password Strength:</span>
          <span
            :class="{
              'text-red-600': passwordStrength.color === 'red',
              'text-yellow-600': passwordStrength.color === 'yellow',
              'text-green-600': passwordStrength.color === 'green'
            }"
          >
            {{ passwordStrength.label }}
          </span>
        </div>
        <div class="h-2 bg-(--ui-bg-accented) rounded-full overflow-hidden">
          <div
            class="h-full transition-all duration-300"
            :class="{
              'bg-red-500': passwordStrength.color === 'red',
              'bg-yellow-500': passwordStrength.color === 'yellow',
              'bg-green-500': passwordStrength.color === 'green'
            }"
            :style="{ width: passwordStrength.strength + '%' }"
          />
        </div>
      </div>
      <UFormField label="Confirm New Password">
        <UInput
          v-model="passwordState.confirm_password"
          type="password"
          size="lg"
          :disabled="passwordLoading"
          placeholder="Confirm new password"
          autocomplete="new-password"
        />
      </UFormField>
      <!-- Password Match Indicator -->
      <div
        v-if="passwordState.confirm_password"
        class="text-sm"
      >
        <span
          v-if="passwordMatch"
          class="text-green-600"
        >Passwords match</span>
        <span
          v-else
          class="text-red-600"
        >Passwords do not match</span>
      </div>
      <UAlert
        v-if="passwordError"
        color="error"
        :title="passwordError"
      />
      <UAlert
        v-if="passwordSuccess"
        color="success"
        :title="passwordSuccess"
      />
      <UButton
        type="submit"
        size="lg"
        :loading="passwordLoading"
        :disabled="!canSubmitPassword"
      >
        {{ hasPassword ? 'Change Password' : 'Set Password' }}
      </UButton>
    </form>
  </UCard>
</template>
