<script setup lang="ts">
// A value to paste somewhere else (a DNS record, a webhook URL), with a copy button.
defineProps<{ value: string, label?: string }>()
const copy = useMailCopy()
</script>

<template>
  <div class="flex items-start gap-1 min-w-0">
    <div class="min-w-0 flex-1">
      <div
        v-if="label"
        class="text-xs text-(--ui-text-muted)"
      >
        {{ label }}
      </div>
      <code class="block font-mono text-xs break-all text-(--ui-text-highlighted)">{{ value }}</code>
    </div>
    <UButton
      icon="i-lucide-copy"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`Copy ${label ?? 'value'}`"
      class="shrink-0"
      @click="copy(value, `${label ?? 'Value'} copied`)"
    />
  </div>
</template>
