<script setup lang="ts">
// Settings card that stacks SettingsRow rows (e.g. the account page's
// AccountDisplayName, AccountPassword), under a title when the page has
// more than one group.
defineProps<{ title?: string }>()
</script>

<template>
  <UCard>
    <template
      v-if="title"
      #header
    >
      <h2 class="text-xl font-semibold">
        {{ title }}
      </h2>
    </template>
    <div class="divide-y divide-(--ui-border)">
      <slot />
    </div>
  </UCard>
</template>
