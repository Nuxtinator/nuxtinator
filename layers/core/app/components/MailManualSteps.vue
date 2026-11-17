<script setup lang="ts">
import type { MailManualStep } from '#core/app/composables/useMailAdmin'

defineProps<{ steps: MailManualStep[] }>()
</script>

<template>
  <ol class="space-y-3">
    <li
      v-for="(step, i) in steps"
      :key="i"
      class="flex gap-3"
    >
      <span class="flex items-center justify-center size-6 shrink-0 rounded-full bg-(--ui-bg-elevated) text-xs font-medium">
        {{ i + 1 }}
      </span>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="text-sm font-medium">
          {{ step.title }}
        </div>
        <p
          v-if="step.detail"
          class="text-sm text-(--ui-text-muted) break-words"
        >
          {{ step.detail }}
        </p>
        <MailCopyValue
          v-for="v in step.values ?? []"
          :key="v.label"
          :label="v.label"
          :value="v.value"
        />
      </div>
    </li>
  </ol>
</template>
