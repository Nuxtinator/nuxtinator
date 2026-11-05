<script setup lang="ts">
import { getRecordsTypeRoute } from '#records'

// Records landing — there is no dashboard, so it forwards to the first
// visible record type's list (preferring types without an app of their own). With no visible types a friendly empty state renders.
definePageMeta({ middleware: 'auth' })

const { visibleTypes, ensureTypes } = useRecordsTypes()
const typePath = useRecordsTypePath()

const resolved = ref(false)
onMounted(async () => {
  try {
    await ensureTypes()
  } catch {
    // Fall through to the empty state; the type lists surface real errors.
  }
  const first = visibleTypes.value.find(t => !getRecordsTypeRoute(t.key)) ?? visibleTypes.value[0]
  if (first) {
    await navigateTo(typePath(first.key), { replace: true })
    return
  }
  resolved.value = true
})
</script>

<template>
  <div class="grid place-items-center py-24 text-(--ui-text-muted)">
    <div
      v-if="resolved"
      class="text-center max-w-sm space-y-3"
    >
      <UIcon
        name="i-lucide-contact"
        class="size-10 opacity-50"
      />
      <p class="text-sm">
        No record types are available yet.
      </p>
    </div>
  </div>
</template>
