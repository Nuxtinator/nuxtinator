<script setup lang="ts">
// Who can see a container (a project, a portfolio): a checklist of Everyone
// and the teams. Offers the caller's teams (every team for holders of
// the app's `all_teams` permission). Teams already on the container stay
// listed even when the caller can't pick them. Renders nothing unless the
// container is limited or the org runs teams and the caller has one to pick.
// A new container binds `fresh` (true when its form opens): the first time the
// field shows, it starts with nothing ticked so the creator chooses, then
// clears `fresh` so going back to the form keeps that choice.
const props = defineProps<{
  appId: string
  // Teams the container is limited to now, for display.
  currentTeams?: { id: string, name: string, archived?: boolean }[]
  disabled?: boolean
}>()

const visibility = defineModel<string>('visibility', { required: true })
const teamIds = defineModel<string[]>('teamIds', { required: true })
const fresh = defineModel<boolean>('fresh', { default: false })

const { mode, teams } = useTeams(props.appId)

const shown = computed(() => (mode.value === 'teams' && teams.value.length > 0) || visibility.value === 'teams')

watch(shown, (on) => {
  if (!on || !fresh.value) return
  fresh.value = false
  visibility.value = 'teams'
  teamIds.value = []
}, { immediate: true })

const teamItems = computed(() => {
  const items = teams.value.filter(t => !t.archived).map(t => ({ id: t.id, name: t.name }))
  const known = new Set(items.map(t => t.id))
  for (const t of props.currentTeams ?? []) {
    if (!known.has(t.id)) items.push({ id: t.id, name: t.archived ? `${t.name} (archived)` : t.name })
  }
  return items
})

// "Everyone" checks every team too. Unticking a team from there limits the
// container to the rest; unticking Everyone starts from no teams.
const everyone = computed(() => visibility.value !== 'teams')
const isChecked = (id: string) => everyone.value || teamIds.value.includes(id)

const onEveryone = (on: boolean) => {
  if (on) {
    visibility.value = 'org'
  } else {
    visibility.value = 'teams'
    teamIds.value = []
  }
}

const onTeam = (id: string, on: boolean) => {
  if (everyone.value) {
    visibility.value = 'teams'
    teamIds.value = teamItems.value.map(t => t.id).filter(t => t !== id)
  } else {
    teamIds.value = on ? [...teamIds.value.filter(t => t !== id), id] : teamIds.value.filter(t => t !== id)
  }
}
</script>

<template>
  <UFormField
    v-if="shown"
    :help="!everyone && teamIds.length === 0 ? 'Pick Everyone or at least one team.' : undefined"
  >
    <template #label>
      Who can see it
      <InfoTip text="Untick Everyone to limit it to teams and hide it from everyone else in the org. Admins can still show all teams." />
    </template>
    <ul class="max-h-72 overflow-y-auto divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
      <CheckboxRow
        :checked="everyone"
        label="Everyone"
        :disabled="disabled"
        @toggle="onEveryone"
      >
        <UIcon
          name="i-lucide-users"
          class="size-4 text-(--ui-text-muted)"
        />
        <span class="text-sm font-medium">Everyone</span>
      </CheckboxRow>
      <CheckboxRow
        v-for="t in teamItems"
        :key="t.id"
        :checked="isChecked(t.id)"
        :label="t.name"
        :disabled="disabled"
        @toggle="onTeam(t.id, $event)"
      />
    </ul>
  </UFormField>
</template>
