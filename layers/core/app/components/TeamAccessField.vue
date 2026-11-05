<script setup lang="ts">
// Who can see a container (a project, a portfolio): everyone in the org, or
// only certain teams. Offers the caller's teams (every team for holders of
// the app's `all_teams` permission). Teams already on the container stay
// listed even when the caller can't pick them. Renders nothing unless the
// container is limited or the org runs teams and the caller has one to pick.
const props = defineProps<{
  appId: string
  // Teams the container is limited to now, for display.
  currentTeams?: { id: string, name: string, archived?: boolean }[]
  disabled?: boolean
}>()

const visibility = defineModel<string>('visibility', { required: true })
const teamIds = defineModel<string[]>('teamIds', { required: true })

const { mode, teams } = useTeams(props.appId)

const shown = computed(() => (mode.value === 'teams' && teams.value.length > 0) || visibility.value === 'teams')

const options = [
  { label: 'Everyone in the org', value: 'org' },
  { label: 'Only certain teams', value: 'teams' }
]

const teamItems = computed(() => {
  const items = teams.value.filter(t => !t.archived).map(t => ({ id: t.id, name: t.name }))
  const known = new Set(items.map(t => t.id))
  for (const t of props.currentTeams ?? []) {
    if (!known.has(t.id)) items.push({ id: t.id, name: t.archived ? `${t.name} (archived)` : t.name })
  }
  return items
})
</script>

<template>
  <div
    v-if="shown"
    class="space-y-2"
  >
    <UFormField>
      <template #label>
        Who can see it
        <InfoTip text="Limit it to teams to hide it from everyone else in the org. Admins can still show all teams." />
      </template>
      <URadioGroup
        v-model="visibility"
        :items="options"
        :disabled="disabled"
      />
    </UFormField>
    <UFormField
      v-if="visibility === 'teams'"
      label="Teams"
      :help="teamItems.length === 0 ? 'You are not on any team.' : undefined"
    >
      <USelectMenu
        v-model="teamIds"
        :items="teamItems"
        value-key="id"
        label-key="name"
        multiple
        placeholder="Pick teams"
        :disabled="disabled || teamItems.length === 0"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
