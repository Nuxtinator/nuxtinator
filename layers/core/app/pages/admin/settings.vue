<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

interface HostSettings {
  selfRegistration: boolean
}

const toast = useToast()

const { data, refresh } = await useFetch<HostSettings>('/api/admin/settings')
const saving = ref(false)

async function onSetSelfRegistration(selfRegistration: boolean) {
  saving.value = true
  try {
    await $fetch('/api/admin/settings', { method: 'PUT', body: { selfRegistration } })
    toast.add({ title: selfRegistration ? 'Registration opened' : 'Registration closed', color: 'success' })
    await refresh()
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-2xl font-bold">
      Settings
    </h1>

    <UCard v-if="data">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="font-medium">
            Allow self-registration
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            Let anyone create an account from the sign-up page or by signing in with a provider.
            When off, new people can join only through an invitation.
          </p>
        </div>
        <USwitch
          :model-value="data.selfRegistration"
          :disabled="saving"
          size="lg"
          @update:model-value="onSetSelfRegistration"
        />
      </div>
    </UCard>
  </div>
</template>
