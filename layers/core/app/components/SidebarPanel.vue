<script setup lang="ts">
// Standardized chrome for sidebars. Owns the bg + border treatment so every
// sidebar in the app looks the same without each call site re-stating it.
//
// `variant` switches between two layout patterns:
//   - 'docked'   (default): sits flush against neighboring content with a
//     right-border. Used in layout-slot positions like /admin and /settings.
//   - 'floating': free-standing column inside a page (e.g. messages page);
//     gets a full border + rounded corners so the elevated surface has
//     defined edges next to neighboring panels.
//
// Width / sticky positioning belong on the call site — pass them as classes
// and Vue's default attribute inheritance merges them onto the root <aside>.
defineProps<{
  title?: string
  variant?: 'docked' | 'floating'
}>()
</script>

<template>
  <aside
    class="flex flex-col h-full bg-(--chrome-bg)"
    :class="variant === 'floating'
      ? 'border border-(--ui-border) rounded-lg'
      : 'border-r border-(--ui-border)'"
  >
    <div
      v-if="title || $slots.header"
      class="px-6 py-5 border-b border-(--ui-border)"
    >
      <slot name="header">
        <h1 class="text-xl font-semibold">
          {{ title }}
        </h1>
      </slot>
    </div>
    <div class="flex-1 px-3 py-4 overflow-y-auto">
      <slot />
    </div>
    <div
      v-if="$slots.footer"
      class="border-t border-(--ui-border) px-4 py-4"
    >
      <slot name="footer" />
    </div>
  </aside>
</template>
