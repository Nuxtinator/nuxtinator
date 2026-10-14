<script setup lang="ts">
// One row of an AccountGroup card: label and current value on the left,
// actions on the right, and a panel underneath that shows while `open`.
defineProps<{ label: string, value?: string, open?: boolean }>()
</script>

<template>
  <div class="py-4 first:pt-0 last:pb-0">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <slot name="leading" />
        <div class="min-w-0">
          <div class="font-medium">
            {{ label }}
          </div>
          <div
            v-if="value || $slots.default"
            class="text-sm text-(--ui-text-muted) truncate"
          >
            <slot>{{ value }}</slot>
          </div>
        </div>
      </div>
      <div
        v-if="$slots.actions"
        class="flex items-center gap-2 shrink-0"
      >
        <slot name="actions" />
      </div>
    </div>
    <div
      v-if="$slots.footer"
      class="mt-3"
    >
      <slot name="footer" />
    </div>
    <div
      v-if="open"
      class="mt-4 rounded-lg bg-(--ui-bg-elevated) p-4"
    >
      <slot name="panel" />
    </div>
  </div>
</template>
