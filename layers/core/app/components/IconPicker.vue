<script setup lang="ts">
// Icon selector: a square button showing the chosen icon that opens the
// searchable grid (IconPickerPanel) in a popover. The model is the full
// `i-<prefix>-<name>` string, a short text label, or null for no icon.
defineProps<{
  /** Collection prefixes to browse, in display order. */
  collections?: string[]
  disabled?: boolean
}>()

const model = defineModel<string | null>({ default: null })

const open = ref(false)

function onSelect(name: string | null) {
  model.value = name
  open.value = false
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :ui="{ content: 'w-72' }"
  >
    <UButton
      color="neutral"
      variant="outline"
      square
      :disabled="disabled"
      aria-label="Choose an icon"
      title="Choose an icon"
    >
      <AppIcon
        v-if="model"
        :name="model"
        :class="model.startsWith('i-') ? 'size-5' : 'min-w-5 h-5 text-xs'"
      />
      <UIcon
        v-else
        name="i-lucide-smile-plus"
        class="size-5 text-(--ui-text-dimmed)"
      />
    </UButton>
    <template #content>
      <IconPickerPanel
        :collections="collections"
        :selected="model"
        @select="onSelect"
      />
    </template>
  </UPopover>
</template>
