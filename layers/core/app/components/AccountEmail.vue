<script setup lang="ts">
// Account row: the email address, changed from a panel opened from Change.
// The verification link returns to the account page with
// `?email_change=<outcome>`, shown under the row.
const { user } = useAuth()
const { withReauth } = useReauth()
const route = useRoute()
const { open, toggle, close } = useSettingsRow('email')

// Provider-only accounts have no password and confirm through `withReauth`.
const hasPassword = computed(() => user.value?.has_password !== false)

const emailState = reactive({
  new_email: '',
  current_password: ''
})
const emailLoading = ref(false)
const emailError = ref('')
const emailNotice = ref<{ color: 'success' | 'error', title: string } | null>(null)

// Check for email change status in query params
onMounted(() => {
  const emailChangeStatus = route.query.email_change as string
  if (emailChangeStatus) {
    switch (emailChangeStatus) {
      case 'success':
        emailNotice.value = { color: 'success', title: 'Email address successfully changed! You can now log in with your new email.' }
        break
      case 'invalid_token':
        emailNotice.value = { color: 'error', title: 'Invalid or expired verification link' }
        break
      case 'no_pending':
        emailNotice.value = { color: 'error', title: 'No pending email change found' }
        break
      case 'email_taken':
        emailNotice.value = { color: 'error', title: 'The new email address is already in use' }
        break
    }
    clearQueryParam('email_change')
  }
})

watch(open, (isOpen) => {
  if (isOpen) {
    emailState.new_email = ''
    emailState.current_password = ''
    emailError.value = ''
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

    emailNotice.value = { color: 'success', title: `Verification email sent to ${emailState.new_email.trim()}. Click the link in it to confirm the change.` }
    close()
  } catch (err: any) {
    emailError.value = err.data?.statusMessage || 'Failed to request email change'
  } finally {
    emailLoading.value = false
  }
}
</script>

<template>
  <SettingsRow
    label="Email"
    :value="user?.email"
    :open="open"
  >
    <template
      v-if="!open"
      #actions
    >
      <UButton
        color="neutral"
        variant="outline"
        @click="toggle"
      >
        Change
      </UButton>
    </template>
    <template
      v-if="emailNotice"
      #footer
    >
      <UAlert
        :color="emailNotice.color"
        :title="emailNotice.title"
        close
        @update:open="emailNotice = null"
      />
    </template>
    <template #panel>
      <form
        class="space-y-4 max-w-md"
        @submit.prevent="handleEmailChange"
      >
        <p class="text-sm text-(--ui-text-muted)">
          A verification link will be sent to your new email address.
        </p>
        <UFormField label="New email address">
          <UInput
            v-model="emailState.new_email"
            type="email"
            class="w-full"
            autofocus
            :disabled="emailLoading"
            placeholder="Enter new email address"
            autocomplete="email"
          />
        </UFormField>
        <UFormField
          v-if="hasPassword"
          label="Current password"
        >
          <UInput
            v-model="emailState.current_password"
            type="password"
            class="w-full"
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
        <div class="flex gap-2">
          <UButton
            type="submit"
            :loading="emailLoading"
            :disabled="!canSubmitEmail"
          >
            Send verification email
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="emailLoading"
            @click="close"
          >
            Cancel
          </UButton>
        </div>
      </form>
    </template>
  </SettingsRow>
</template>
