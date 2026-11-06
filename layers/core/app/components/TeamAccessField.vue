<script setup lang="ts">
// Who can see a container (a project, a portfolio): a checklist of Everyone
// and the teams. Offers the caller's teams (every team for holders of
// the app's `all_teams` permission). Teams already on the container stay
// listed even when the caller can't pick them. Renders nothing unless the
// container is limited or the org runs teams and the caller has one to pick.
// With `noneValue`, ticking nothing is allowed and saves that visibility (the
// container is then open only to its owner and the people it is shared with);
// the field then always shows, as just Everyone when there are no teams.
// A new container binds `fresh` (true when its form opens): the first time the
// field shows, it starts with nothing ticked so the creator chooses, then
// clears `fresh` so going back to the form keeps that choice.
const props = defineProps<{
  appId: string
  // Teams the container is limited to now, for display.
  currentTeams?: { id: string, name: string, icon?: string | null, image?: string | null, archived?: boolean }[]
  disabled?: boolean
  noneValue?: string
}>()

const visibility = defineModel<string>('visibility', { required: true })
const teamIds = defineModel<string[]>('teamIds', { required: true })
const fresh = defineModel<boolean>('fresh', { default: false })

const { mode, teams } = useTeams(props.appId)

const shown = computed(() => !!props.noneValue || (mode.value === 'teams' && teams.value.length > 0) || visibility.value === 'teams')

watch(shown, (on) => {
  if (!on || !fresh.value) return
  fresh.value = false
  visibility.value = 'teams'
  teamIds.value = []
}, { immediate: true })

const teamItems = computed(() => {
  const items = teams.value.filter(t => !t.archived).map(t => ({ id: t.id, name: t.name, icon: t.icon, image: t.image }))
  const known = new Set(items.map(t => t.id))
  for (const t of props.currentTeams ?? []) {
    if (!known.has(t.id)) items.push({ id: t.id, name: t.archived ? `${t.name} (archived)` : t.name, icon: t.icon ?? null, image: t.image ?? null })
  }
  return items
})

// "Everyone" checks every team too. Unticking a team from there limits the
// container to the rest; unticking Everyone starts from no teams.
const isNone = computed(() => !!props.noneValue && visibility.value === props.noneValue)
const everyone = computed(() => visibility.value !== 'teams' && !isNone.value)
const isChecked = (id: string) => everyone.value || teamIds.value.includes(id)

const setTeams = (ids: string[]) => {
  teamIds.value = ids
  visibility.value = ids.length === 0 && props.noneValue ? props.noneValue : 'teams'
}

const onEveryone = (on: boolean) => {
  if (on) {
    visibility.value = 'org'
    if (props.noneValue) teamIds.value = []
  } else {
    setTeams([])
  }
}

const onTeam = (id: string, on: boolean) => {
  if (everyone.value) {
    setTeams(teamItems.value.map(t => t.id).filter(t => t !== id))
  } else {
    setTeams(on ? [...teamIds.value.filter(t => t !== id), id] : teamIds.value.filter(t => t !== id))
  }
}

const tip = computed(() => props.noneValue
  ? 'Untick Everyone to limit it to teams, or untick everything to keep it to you and the people it is shared with.'
  : 'Untick Everyone to limit it to teams and hide it from everyone else in the org. Admins can still show all teams.')
</script>

<template>
  <UFormField
    v-if="shown"
    :help="!noneValue && !everyone && teamIds.length === 0 ? 'Pick Everyone or at least one team.' : undefined"
  >
    <template #label>
      Who can see it
      <InfoTip :text="tip" />
    </template>
    <ul class="max-h-72 overflow-y-auto divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
      <CheckboxRow
        :checked="everyone"
        label="Everyone"
        :disabled="disabled"
        @toggle="onEveryone"
      >
        <UAvatar
          icon="i-lucide-users"
          size="2xs"
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
      >
        <GroupAvatar
          :name="t.name"
          :icon="t.icon"
          :image="t.image"
          size="2xs"
        />
        <span class="text-sm">{{ t.name }}</span>
      </CheckboxRow>
    </ul>
  </UFormField>
</template>
