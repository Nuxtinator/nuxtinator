<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const { user, logout, deleteAccount, checkAuth } = useAuth()
const { withReauth } = useReauth()

// Provider-only accounts have no password: password fields are hidden and
// sensitive actions confirm through `withReauth` instead.
const hasPassword = computed(() => user.value?.has_password !== false)
const { theme, toggleTheme } = useTheme()
const route = useRoute()

// Layer-injected sections (e.g. OAuth "Connected apps"). Each layer
// registers its own card via a Nuxt app plugin — see
// `app/utils/account-section-registry.ts` for the contract.
const injectedSections = getAccountSections()

// Check for email change status in query params
onMounted(() => {
  const emailChangeStatus = route.query.email_change as string
  if (emailChangeStatus) {
    switch (emailChangeStatus) {
      case 'success':
        emailSuccess.value = 'Email address successfully changed! You can now log in with your new email.'
        break
      case 'invalid_token':
        emailError.value = 'Invalid or expired verification link'
        break
      case 'no_pending':
        emailError.value = 'No pending email change found'
        break
      case 'email_taken':
        emailError.value = 'The new email address is already in use'
        break
    }
  }
})

// State for name change
const nameState = reactive({
  display_name: user.value?.display_name || ''
})
const nameLoading = ref(false)
const nameError = ref('')
const nameSuccess = ref('')

// State for email change
const emailState = reactive({
  new_email: '',
  current_password: ''
})
const emailLoading = ref(false)
const emailError = ref('')
const emailSuccess = ref('')

const canSubmitEmail = computed(() => {
  return emailState.new_email.trim()
    && (emailState.current_password || !hasPassword.value)
    && !emailLoading.value
    && emailState.new_email !== user.value?.email
})

// State for password change
const passwordState = reactive({
  current_password: '',
  new_password: '',
  confirm_password: ''
})
const passwordLoading = ref(false)
const passwordError = ref('')
const passwordSuccess = ref('')

// State for account deletion
const deleteState = reactive({
  password: '',
  confirmDelete: false
})
const deleteLoading = ref(false)
const deleteError = ref('')

// Watch user changes to update name field
watch(user, (newUser) => {
  if (newUser) {
    nameState.display_name = newUser.display_name
  }
})

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

// Handle name update
async function handleNameUpdate() {
  nameError.value = ''
  nameSuccess.value = ''

  if (!nameState.display_name.trim()) {
    nameError.value = 'Display name is required'
    return
  }

  nameLoading.value = true

  try {
    await $fetch('/api/profile/name', {
      method: 'PATCH',
      body: {
        display_name: nameState.display_name.trim()
      }
    })

    nameSuccess.value = 'Display name updated successfully'

    // Update user in auth composable
    if (user.value) {
      user.value.display_name = nameState.display_name.trim()
    }
  } catch (err: any) {
    nameError.value = err.data?.statusMessage || 'Failed to update display name'
  } finally {
    nameLoading.value = false
  }
}

// Handle email change
async function handleEmailChange() {
  emailError.value = ''
  emailSuccess.value = ''

  if (!canSubmitEmail.value) {
    return
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(emailState.new_email)) {
    emailError.value = 'Please enter a valid email address'
    return
  }

  emailLoading.value = true

  try {
    await withReauth(() => $fetch('/api/profile/email', {
      method: 'POST',
      body: {
        new_email: emailState.new_email.trim(),
        ...(hasPassword.value ? { current_password: emailState.current_password } : {})
      }
    }))

    emailSuccess.value = 'Verification email sent! Please check your new email address to confirm the change.'

    // Reset form
    emailState.new_email = ''
    emailState.current_password = ''
  } catch (err: any) {
    emailError.value = err.data?.statusMessage || 'Failed to request email change'
  } finally {
    emailLoading.value = false
  }
}

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

// Handle account deletion
async function handleDeleteAccount() {
  deleteError.value = ''

  if ((hasPassword.value && !deleteState.password) || !deleteState.confirmDelete) {
    return
  }

  deleteLoading.value = true

  try {
    const result = hasPassword.value
      ? await deleteAccount(deleteState.password)
      : await withReauth(() => deleteAccount())

    if (!result.success) {
      deleteError.value = result.message || 'Failed to delete account'
    }
  } catch (err: any) {
    deleteError.value = err.data?.statusMessage || 'Failed to delete account'
  } finally {
    deleteLoading.value = false
  }
}

// Reset delete confirmation when password changes
watch(() => deleteState.password, () => {
  deleteState.confirmDelete = false
})
</script>

<template>
  <div class="max-w-2xl mx-auto space-y-6">
    <h1 class="text-3xl font-bold">
      Account Settings
    </h1>

    <!-- Account Info -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold">
          Account Information
        </h2>
      </template>
      <div class="space-y-2 text-sm">
        <div>
          <span class="font-medium">Email:</span>
          <span class="ml-2 text-(--ui-text-muted)">{{ user?.email }}</span>
        </div>
        <div>
          <span class="font-medium">Account created:</span>
          <span class="ml-2 text-(--ui-text-muted)">
            {{ new Date(user?.created).toLocaleDateString() }}
          </span>
        </div>
      </div>
    </UCard>

    <!-- Appearance -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold">
          Appearance
        </h2>
      </template>
      <div class="flex items-center justify-between gap-4">
        <div>
          <div class="font-medium">
            Theme
          </div>
          <div class="text-sm text-(--ui-text-muted)">
            Switch between light and dark mode.
          </div>
        </div>
        <UButton
          variant="outline"
          color="neutral"
          size="md"
          :icon="theme === 'light' ? 'i-lucide-moon' : 'i-lucide-sun'"
          @click="toggleTheme"
        >
          {{ theme === 'light' ? 'Switch to dark' : 'Switch to light' }}
        </UButton>
      </div>
    </UCard>

    <!-- Change Display Name -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold">
          Change Display Name
        </h2>
      </template>
      <form
        class="space-y-4"
        @submit.prevent="handleNameUpdate"
      >
        <UFormField label="Display Name">
          <UInput
            v-model="nameState.display_name"
            type="text"
            size="lg"
            :disabled="nameLoading"
            placeholder="Enter your display name"
          />
        </UFormField>
        <UAlert
          v-if="nameError"
          color="error"
          :title="nameError"
        />
        <UAlert
          v-if="nameSuccess"
          color="success"
          :title="nameSuccess"
        />
        <UButton
          type="submit"
          size="lg"
          :loading="nameLoading"
          :disabled="!nameState.display_name.trim() || nameLoading"
        >
          Update Name
        </UButton>
      </form>
    </UCard>

    <!-- Change Email -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold">
          Change Email Address
        </h2>
      </template>
      <form
        class="space-y-4"
        @submit.prevent="handleEmailChange"
      >
        <div class="text-sm text-(--ui-text-muted) mb-4">
          <p>Current email: <strong>{{ user?.email }}</strong></p>
          <p class="mt-2">
            A verification link will be sent to your new email address.
          </p>
        </div>
        <UFormField label="New Email Address">
          <UInput
            v-model="emailState.new_email"
            type="email"
            size="lg"
            :disabled="emailLoading"
            placeholder="Enter new email address"
            autocomplete="email"
          />
        </UFormField>
        <UFormField
          v-if="hasPassword"
          label="Current Password"
        >
          <UInput
            v-model="emailState.current_password"
            type="password"
            size="lg"
            :disabled="emailLoading"
            placeholder="Enter your current password"
            autocomplete="current-password"
          />
        </UFormField>
        <UAlert
          v-if="emailError"
          color="error"
          :title="emailError"
        />
        <UAlert
          v-if="emailSuccess"
          color="success"
          :title="emailSuccess"
        />
        <UButton
          type="submit"
          size="lg"
          :loading="emailLoading"
          :disabled="!canSubmitEmail"
        >
          Send Verification Email
        </UButton>
      </form>
    </UCard>

    <!-- Change Password -->
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

    <AccountSignInMethods />

    <AccountSessions />

    <!-- Layer-injected sections (e.g. OAuth Connected apps) -->
    <component
      :is="section.component"
      v-for="section in injectedSections"
      :key="section.id"
    />

    <!-- Sign Out -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold">
          Sign Out
        </h2>
      </template>
      <div class="space-y-4">
        <p class="text-sm text-(--ui-text-muted)">
          Sign out of your account on this device.
        </p>
        <UButton
          color="error"
          variant="outline"
          size="lg"
          @click="logout"
        >
          Sign Out
        </UButton>
      </div>
    </UCard>

    <!-- Delete Account -->
    <UCard>
      <template #header>
        <h2 class="text-xl font-semibold text-red-600">
          Delete Account
        </h2>
      </template>
      <div class="space-y-4">
        <UAlert
          color="warning"
          title="Warning: This action is permanent"
          description="Deleting your account will permanently remove all your data. This action cannot be undone."
        />
        <UFormField
          v-if="hasPassword"
          label="Enter your password to confirm"
        >
          <UInput
            v-model="deleteState.password"
            type="password"
            size="lg"
            :disabled="deleteLoading"
            placeholder="Enter your password"
            autocomplete="current-password"
          />
        </UFormField>
        <div class="flex items-center gap-2">
          <UCheckbox
            v-model="deleteState.confirmDelete"
            :disabled="(hasPassword && !deleteState.password) || deleteLoading"
          />
          <span class="text-sm">I understand this action is permanent and cannot be undone</span>
        </div>
        <UAlert
          v-if="deleteError"
          color="error"
          :title="deleteError"
        />
        <UButton
          color="error"
          size="lg"
          :loading="deleteLoading"
          :disabled="(hasPassword && !deleteState.password) || !deleteState.confirmDelete || deleteLoading"
          @click="handleDeleteAccount"
        >
          Delete My Account
        </UButton>
      </div>
    </UCard>

    <ReauthModal />
  </div>
</template>
