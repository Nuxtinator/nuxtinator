<script setup lang="ts">
// Account card: change the email address. The verification link returns to
// the account page with `?email_change=<outcome>`, shown here.
const { user } = useAuth()
const { withReauth } = useReauth()
const route = useRoute()

// Provider-only accounts have no password and confirm through `withReauth`.
const hasPassword = computed(() => user.value?.has_password !== false)

const emailState = reactive({
  new_email: '',
  current_password: ''
})
const emailLoading = ref(false)
const emailError = ref('')
const emailSuccess = ref('')

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
    clearQueryParam('email_change')
  }
})

const canSubmitEmail = computed(() => {
  return emailState.new_email.trim()
    && (emailState.current_password || !hasPassword.value)
    && !emailLoading.value
    && emailState.new_email !== user.value?.email
})

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
</script>

<template>
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
</template>
