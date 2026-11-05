<script setup lang="ts">
// A list row that toggles a checkbox when clicked anywhere. Put it in a
// `<ul>`; the slot holds what sits beside the box (a name, an avatar).
const props = defineProps<{
  checked: boolean
  label: string
  disabled?: boolean
}>()
const emit = defineEmits<{ toggle: [on: boolean] }>()

const onClick = () => {
  if (!props.disabled) emit('toggle', !props.checked)
}
</script>

<template>
  <li
    class="px-3 py-2"
    :class="disabled ? 'opacity-75' : 'cursor-pointer hover:bg-(--ui-bg-elevated)'"
    @click="onClick"
  >
    <!-- Mouse clicks land on the row; a keyboard press on the box bubbles up to it. -->
    <div class="flex items-center gap-3 pointer-events-none">
      <UCheckbox
        :model-value="checked"
        :disabled="disabled"
        :aria-label="label"
      />
      <slot>
        <span class="text-sm">{{ label }}</span>
      </slot>
    </div>
  </li>
</template>
