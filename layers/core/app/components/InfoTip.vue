<script setup lang="ts">
// A small (i) button that opens help text in a popover, so explanations stay off the page.
// Click (not hover) so it also works on touch screens.
defineProps<{ text?: string }>()
</script>

<template>
  <UPopover :content="{ side: 'top', align: 'start' }" arrow>
    <UButton
      icon="i-lucide-info"
      color="neutral"
      variant="link"
      size="xs"
      aria-label="More info"
      class="p-0 align-[-0.2em] text-(--ui-text-dimmed) hover:text-(--ui-text-toned)"
    />
    <template #content>
      <div class="max-w-xs p-3 text-sm text-(--ui-text-toned) space-y-2">
        <slot>{{ text }}</slot>
      </div>
    </template>
  </UPopover>
</template>
