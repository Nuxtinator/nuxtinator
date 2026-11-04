<script setup lang="ts">
// Floating entry point for the assistant. Rendered by every context page via
// ContextSidebar; hidden until the AI status probe says the feature can run.
const { open, openPanel } = useContextAssistant()
const { available } = useContextAssistantStatus()
</script>

<template>
  <Teleport to="body">
    <UButton
      v-if="available && !open"
      icon="i-lucide-sparkles"
      size="xl"
      color="primary"
      class="fixed bottom-6 right-6 z-40 rounded-full shadow-lg"
      aria-label="Open assistant"
      title="Assistant"
      @click="openPanel()"
    />
  </Teleport>
  <ContextAssistantPanel />
</template>
