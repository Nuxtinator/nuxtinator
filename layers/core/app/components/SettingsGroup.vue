<script setup lang="ts">
// Settings card that stacks SettingsRow rows (e.g. the account page's
// AccountDisplayName, AccountPassword) under a title.
defineProps<{ title: string }>()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        {{ title }}
      </h2>
    </template>
    <div class="divide-y divide-(--ui-border)">
      <slot />
    </div>
  </UCard>
</template>
