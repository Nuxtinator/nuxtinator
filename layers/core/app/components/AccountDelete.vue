<script setup lang="ts">
// Account row: permanently delete the account. The panel opened from
// Delete confirms by password or, without one, by re-authentication.
const { user, deleteAccount } = useAuth()
const { withReauth } = useReauth()
const { open, toggle, close } = useAccountRow('delete')

const hasPassword = computed(() => user.value?.has_password !== false)

const deleteState = reactive({
  password: '',
  confirmDelete: false
})
const deleteLoading = ref(false)
const deleteError = ref('')

watch(open, (isOpen) => {
  if (isOpen) {
    deleteState.password = ''
    deleteState.confirmDelete = false
    deleteError.value = ''
  }
})

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
  <AccountRow
    label="Delete account"
    value="Permanently remove your account and all of its data."
    :open="open"
  >
    <template
      v-if="!open"
      #actions
    >
      <UButton
        color="error"
        variant="outline"
        @click="toggle"
      >
        Delete…
      </UButton>
    </template>
    <template #panel>
      <div class="space-y-4 max-w-md">
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
            class="w-full"
            autofocus
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
        <div class="flex gap-2">
          <UButton
            color="error"
            :loading="deleteLoading"
            :disabled="(hasPassword && !deleteState.password) || !deleteState.confirmDelete || deleteLoading"
            @click="handleDeleteAccount"
          >
            Delete my account
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="deleteLoading"
            @click="close"
          >
            Cancel
          </UButton>
        </div>
      </div>
    </template>
  </AccountRow>
</template>
