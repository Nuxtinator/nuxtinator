<script setup lang="ts">
// The link from a task's list of subtasks to the board of them. Shown in the
// list's heading on the record's details (registered in
// plugins/register-views-ui.ts), except on that board itself.
const props = defineProps<{
  recordId: string
  recordType: string
}>()

const route = useRoute()
const { boardRoute } = useViewsSubtasksBoard()

const to = computed(() =>
  route.params.id === viewsSubtasksViewId(props.recordId) ? null : boardRoute(props.recordId))
</script>

<template>
  <UButton
    v-if="to"
    :to="to"
    icon="i-lucide-kanban"
    color="neutral"
    variant="ghost"
    size="xs"
  >
    Board
  </UButton>
</template>
