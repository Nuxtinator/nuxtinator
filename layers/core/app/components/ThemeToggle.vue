<script setup lang="ts">
withDefaults(defineProps<{ size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' }>(), { size: 'lg' })

const { theme, toggleTheme } = useTheme()
</script>

<template>
  <UButton
    variant="ghost"
    color="neutral"
    :size="size"
    :icon="theme === 'light' ? 'i-lucide-moon' : 'i-lucide-sun'"
    :aria-label="theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'"
    title="Toggle theme"
    @click="toggleTheme"
  />
</template>
