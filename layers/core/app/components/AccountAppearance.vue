<script setup lang="ts">
// Account card: light / dark theme switch.
const { theme, toggleTheme } = useTheme()
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-xl font-semibold">
        Appearance
      </h2>
    </template>
    <div class="flex items-center justify-between gap-4">
      <div>
        <div class="font-medium">
          Theme
        </div>
        <div class="text-sm text-(--ui-text-muted)">
          Switch between light and dark mode.
        </div>
      </div>
      <UButton
        variant="outline"
        color="neutral"
        size="md"
        :icon="theme === 'light' ? 'i-lucide-moon' : 'i-lucide-sun'"
        @click="toggleTheme"
      >
        {{ theme === 'light' ? 'Switch to dark' : 'Switch to light' }}
      </UButton>
    </div>
  </UCard>
</template>
