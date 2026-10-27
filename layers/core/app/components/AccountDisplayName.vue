<script setup lang="ts">
// Account row: the display name, edited in a panel opened from Change.
const { user } = useAuth()
const toast = useToast()
const { open, toggle, close } = useSettingsRow('display-name')

const nameState = reactive({
  display_name: ''
})
const nameLoading = ref(false)
const nameError = ref('')

watch(open, (isOpen) => {
  if (isOpen) {
    nameState.display_name = user.value?.display_name || ''
    nameError.value = ''
  }
})

// Handle name update
async function handleNameUpdate() {
  nameError.value = ''

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

    // Update user in auth composable
    if (user.value) {
      user.value.display_name = nameState.display_name.trim()
    }

    toast.add({ title: 'Display name updated', color: 'success' })
    close()
  } catch (err: any) {
    nameError.value = err.data?.statusMessage || 'Failed to update display name'
  } finally {
    nameLoading.value = false
  }
}
</script>

<template>
  <SettingsRow
    label="Display name"
    :value="user?.display_name || 'Not set'"
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
    <template #panel>
      <form
        class="space-y-4 max-w-md"
        @submit.prevent="handleNameUpdate"
      >
        <UFormField label="Display name">
          <UInput
            v-model="nameState.display_name"
            type="text"
            class="w-full"
            autofocus
            :disabled="nameLoading"
            placeholder="Enter your display name"
          />
        </UFormField>
        <UAlert
          v-if="nameError"
          color="error"
          :title="nameError"
        />
        <div class="flex gap-2">
          <UButton
            type="submit"
            :loading="nameLoading"
            :disabled="!nameState.display_name.trim() || nameLoading"
          >
            Save
          </UButton>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="nameLoading"
            @click="close"
          >
            Cancel
          </UButton>
        </div>
      </form>
    </template>
  </SettingsRow>
</template>
