<script setup lang="ts">
// Detail-page panel listing the records whose rich text links to this one
// ("#" chips), as chips that open them. Only records the caller may open
// come back. Renders nothing when there are none.
const props = defineProps<{
  typeKey: string
  recordId: string
}>()

const typePath = useRecordsTypePath()
const { types, ensureTypes } = useRecordsTypes()

interface MentioningRecord {
  id: string
  typeKey: string
  name: string
}

const items = ref<MentioningRecord[]>([])

async function refresh() {
  try {
    const url: string = `/api/records/entries/${props.typeKey}/${props.recordId}/mentions`
    items.value = (await $fetch<{ items: MentioningRecord[] }>(url)).items
  } catch {
    items.value = []
  }
}
watch(() => [props.typeKey, props.recordId], refresh, { immediate: true })
onMounted(() => {
  ensureTypes().catch(() => {
    // Chips fall back to a plain link icon.
  })
})
defineExpose({ refresh })

const iconOf = (typeKey: string) => types.value.find(t => t.key === typeKey)?.icon ?? 'i-lucide-link'
</script>

<template>
  <RecordsFieldSection
    v-if="items.length > 0"
    label="Mentioned in"
  >
    <div class="flex flex-wrap gap-1.5 px-4 py-3">
      <UButton
        v-for="item in items"
        :key="item.id"
        :to="typePath(item.typeKey, item.id)"
        color="neutral"
        variant="subtle"
        size="xs"
        :icon="iconOf(item.typeKey)"
      >
        {{ item.name }}
      </UButton>
    </div>
  </RecordsFieldSection>
</template>
