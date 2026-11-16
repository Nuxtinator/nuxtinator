<script setup lang="ts">
// One row of a SettingsGroup card: label, an optional (i) explanation and
// current value on the left, actions on the right, and a panel underneath
// that shows while `open`.
defineProps<{ label: string, help?: string, value?: string, open?: boolean }>()
</script>

<template>
  <div class="py-4 first:pt-0 last:pb-0">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <slot name="leading" />
        <div class="min-w-0">
          <div class="font-medium flex items-center gap-1">
            {{ label }}
            <InfoTip
              v-if="help || $slots.help"
              :text="help"
            >
              <slot
                v-if="$slots.help"
                name="help"
              />
            </InfoTip>
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
