<script setup lang="ts">
// Older name for SettingsRow, kept for hosts' own account pages.
const props = defineProps<{ label: string, value?: string, open?: boolean }>()
</script>

<template>
  <SettingsRow v-bind="props">
    <template
      v-for="(_, name) in $slots"
      #[name]="slotProps"
    >
      <slot
        :name="name"
        v-bind="slotProps ?? {}"
      />
    </template>
  </SettingsRow>
</template>
