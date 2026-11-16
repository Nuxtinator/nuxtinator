<script setup lang="ts">
// The titled card a signed-out page (sign in, register, reset, invite) puts its form in.
// `footer` is the line under the card that leads to the neighbouring page; `note` is small print below it.
defineProps<{ title: string }>()
</script>

<template>
  <div>
    <UCard :ui="{ body: 'p-6 sm:p-8' }">
      <h1 class="text-2xl font-semibold tracking-tight text-(--ui-text-highlighted) text-balance mb-6">
        {{ title }}
      </h1>
      <slot />
    </UCard>
    <div
      v-if="$slots.footer"
      class="mt-6 text-center text-sm text-(--ui-text-muted)"
    >
      <slot name="footer" />
    </div>
    <p
      v-if="$slots.note"
      class="mt-4 text-center text-xs text-(--ui-text-dimmed) text-balance"
    >
      <slot name="note" />
    </p>
  </div>
</template>
