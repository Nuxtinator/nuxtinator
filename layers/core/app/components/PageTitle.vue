<script setup lang="ts">
// The title row of a page: its name, an optional (i) explanation, and the page's actions on the right.
defineProps<{ title: string, help?: string }>()
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
    <div class="flex items-center gap-1.5 min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight text-(--ui-text-highlighted) truncate">
        {{ title }}
      </h1>
      <slot name="badge" />
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
      v-if="$slots.default"
      class="flex items-center gap-2 shrink-0"
    >
      <slot />
    </div>
  </header>
</template>
