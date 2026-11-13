<script setup lang="ts">
// The top bar of every page shown before sign-in: the app's name linking home, and the theme toggle.
const config = useRuntimeConfig()
</script>

<template>
  <header class="bg-(--chrome-bg) border-b border-(--ui-border) py-4">
    <div class="max-w-7xl mx-auto px-4 flex justify-between items-center">
      <NuxtLink
        to="/"
        class="text-xl font-semibold hover:text-(--ui-text-muted) transition-colors"
      >
        {{ config.public.appName }}
      </NuxtLink>
      <ThemeToggle />
    </div>
  </header>
</template>
