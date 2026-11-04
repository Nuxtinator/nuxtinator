<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

interface HostSettings {
  selfRegistration: boolean
  groupMode: 'audiences' | 'teams'
  labels: { selfRegistration: string, groupMode: string }
}

const GROUP_MODE_OPTIONS = [
  { value: 'audiences', label: 'Audiences' },
  { value: 'teams', label: 'Teams' }
]

const toast = useToast()
const confirmAction = useConfirm()

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

async function onSetGroupMode(groupMode: 'audiences' | 'teams') {
  if (!data.value || groupMode === data.value.groupMode) return
  if (groupMode === 'teams' && !await confirmAction({
    title: 'Run groups as teams?',
    description: 'Members of each group will see the group and each other.',
    confirmLabel: 'Switch to teams',
    color: 'primary'
  })) return
  saving.value = true
  try {
    await $fetch('/api/admin/settings', { method: 'PUT', body: { groupMode } })
    toast.add({ title: groupMode === 'teams' ? 'Groups run as teams' : 'Groups run as audiences', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
    await refresh()
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
            {{ data.labels.selfRegistration }}
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

    <UCard v-if="data">
      <div class="flex items-center justify-between gap-4">
        <h2 class="font-medium flex items-center gap-1">
          {{ data.labels.groupMode }}
          <InfoTip>
            <p>Audiences: groups only decide who can open apps. Members don't see the group's other members.</p>
            <p>Teams: members see their groups and each other.</p>
          </InfoTip>
        </h2>
        <USelect
          :model-value="data.groupMode"
          :items="GROUP_MODE_OPTIONS"
          :disabled="saving"
          class="w-40"
          @update:model-value="(v: string) => onSetGroupMode(v as 'audiences' | 'teams')"
        />
      </div>
    </UCard>
  </div>
</template>
