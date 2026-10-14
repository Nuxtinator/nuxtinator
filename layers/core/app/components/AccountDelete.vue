<script setup lang="ts">
// Account card: permanently delete the account, confirmed by password or,
// without one, by re-authentication.
const { user, deleteAccount } = useAuth()
const { withReauth } = useReauth()

const hasPassword = computed(() => user.value?.has_password !== false)

const deleteState = reactive({
  password: '',
  confirmDelete: false
})
const deleteLoading = ref(false)
const deleteError = ref('')

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
</template>
