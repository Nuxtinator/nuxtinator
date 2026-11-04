<script setup lang="ts">
// A collapsible sidebar group: a chevron + title that toggles the list, and an
// optional "+" that jumps straight to the create page. The collapsed state is
// remembered per section in a cookie so it survives navigation and reloads.
const props = defineProps<{
  id: string
  title: string
  addTo?: string
  addLabel?: string
}>()

const collapsed = useCookie<boolean>(`helpinator-sidebar-${props.id}-collapsed`, {
  default: () => false,
  maxAge: 60 * 60 * 24 * 365
})
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between px-1 mb-1">
      <button
        type="button"
        class="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted) hover:text-(--ui-text) transition"
        :aria-expanded="!collapsed"
        @click.stop="collapsed = !collapsed"
      >
        <UIcon
          name="i-lucide-chevron-down"
          class="size-3.5 shrink-0 transition-transform"
          :class="{ '-rotate-90': collapsed }"
        />
        {{ title }}
      </button>
      <UButton
        v-if="addTo"
        :to="addTo"
        icon="i-lucide-plus"
        variant="ghost"
        color="neutral"
        size="xs"
        :aria-label="addLabel ?? `New ${title.toLowerCase()}`"
      />
    </div>

    <div v-show="!collapsed">
      <slot />
    </div>
  </div>
</template>
