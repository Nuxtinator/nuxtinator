<script setup lang="ts">
// Zero-records state for a type's list page, with a create call-to-action
// (shown only when the caller's canCreate capability allows it).
defineProps<{
  typeLabel: string
  labelSingular: string
  canCreate: boolean
}>()

defineEmits<{
  create: []
}>()
</script>

<template>
  <div class="grid place-items-center py-24 text-(--ui-text-muted)">
    <div class="text-center max-w-sm space-y-3">
      <UIcon
        name="i-lucide-inbox"
        class="size-10 opacity-50"
      />
      <p class="text-sm">
        No {{ typeLabel.toLowerCase() }} yet.
      </p>
      <UButton
        v-if="canCreate"
        icon="i-lucide-plus"
        @click="$emit('create')"
      >
        New {{ labelSingular.toLowerCase() }}
      </UButton>
    </div>
  </div>
</template>
