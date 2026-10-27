<script setup lang="ts">
// Save and Discard for a page edited as one form, held at the bottom of the
// screen while the page scrolls. Pair it with useUnsavedGuard().
withDefaults(defineProps<{ dirty: boolean, saving?: boolean, disabled?: boolean, label?: string }>(), { saving: false, disabled: false, label: 'Save' })
defineEmits<{ save: [], discard: [] }>()
</script>

<template>
  <div class="flex justify-end gap-2 sticky bottom-4 z-10">
    <UButton
      v-if="dirty"
      label="Discard changes"
      size="lg"
      color="neutral"
      variant="outline"
      @click="$emit('discard')"
    />
    <UButton
      :label="label"
      size="lg"
      icon="i-lucide-save"
      :loading="saving"
      :disabled="!dirty || disabled"
      @click="$emit('save')"
    />
  </div>
</template>
