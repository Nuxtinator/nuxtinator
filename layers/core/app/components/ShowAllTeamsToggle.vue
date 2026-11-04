<script setup lang="ts">
// "Show all teams" switch for holders of an app's `all_teams` permission.
// The parent places it behind that permission and reloads on `change`.
const props = defineProps<{ appId: string }>()
const emit = defineEmits<{ change: [on: boolean] }>()

const { mode } = useTeams(props.appId)
const showAll = useShowAllTeams(props.appId)

// `useCookie` writes the cookie on the next tick; emit after it so a reload
// sends the new value.
const onUpdate = async (on: boolean) => {
  showAll.value = on
  await nextTick()
  emit('change', on)
}
</script>

<template>
  <USwitch
    v-if="mode === 'teams' || showAll"
    :model-value="showAll"
    label="Show all teams"
    size="sm"
    @update:model-value="onUpdate"
  />
</template>
