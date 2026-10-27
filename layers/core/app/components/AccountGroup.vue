<script setup lang="ts">
// Older name for SettingsGroup, kept for hosts' own account pages.
defineProps<{ title: string }>()
</script>

<template>
  <SettingsGroup :title="title">
    <slot />
  </SettingsGroup>
</template>
