<script setup lang="ts">
// Account card: change the display name.
const { user } = useAuth()

const nameState = reactive({
  display_name: user.value?.display_name || ''
})
const nameLoading = ref(false)
const nameError = ref('')
const nameSuccess = ref('')

// Watch the saved name to update the field, leaving an unsaved edit alone otherwise
watch(() => user.value?.display_name, (name) => {
  if (name) {
    nameState.display_name = name
  }
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
</script>

<template>
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
</template>
