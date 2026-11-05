<script setup lang="ts">
// A titled group of field rows on the record detail page.
defineProps<{
  label?: string
}>()
</script>

<template>
  <section class="space-y-2">
    <h2
      v-if="label"
      class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted) px-1"
    >
      {{ label }}
    </h2>
    <div class="border border-(--ui-border) rounded-lg divide-y divide-(--ui-border) bg-(--ui-bg)">
      <slot />
    </div>
  </section>
</template>
