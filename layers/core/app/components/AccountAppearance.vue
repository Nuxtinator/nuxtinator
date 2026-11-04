<script setup lang="ts">
// Account row: light / dark theme switch.
const { theme, toggleTheme } = useTheme()
</script>

<template>
  <SettingsRow
    label="Theme"
    :value="theme === 'light' ? 'Light' : 'Dark'"
  >
    <template #actions>
      <UButton
        variant="outline"
        color="neutral"
        :icon="theme === 'light' ? 'i-lucide-moon' : 'i-lucide-sun'"
        @click="toggleTheme"
      >
        {{ theme === 'light' ? 'Switch to dark' : 'Switch to light' }}
      </UButton>
    </template>
  </SettingsRow>
</template>
