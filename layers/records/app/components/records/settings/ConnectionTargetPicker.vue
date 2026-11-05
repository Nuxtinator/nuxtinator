<script setup lang="ts">
// The schema builder's extra input for connection fields (registered in
// plugins/register-records-ui.ts): which record type the field links to.
// Locked after the field is created.
const model = defineModel<Record<string, unknown>>({ default: () => ({}) })

defineProps<{
  readonly?: boolean
  disabled?: boolean
}>()

const { types, ensureTypes } = useRecordsTypes()

onMounted(() => {
  // A load failure leaves the picker empty; submit stays disabled.
  ensureTypes().catch(() => {})
})

const items = computed(() =>
  types.value.filter(t => !t.orphan).map(t => ({ label: t.label, value: t.key })))

const target = computed({
  get: () => typeof model.value.target === 'string' ? model.value.target : undefined,
  set: (v: string | undefined) => { model.value = { ...model.value, target: v } }
})
</script>

<template>
  <UFormField
    label="Links to"
    :required="!readonly"
    :help="readonly ? undefined : 'The record type this field points at. Locked after the field is created.'"
  >
    <USelectMenu
      v-if="!readonly"
      v-model="target"
      :items="items"
      value-key="value"
      label-key="label"
      placeholder="Pick a record type"
      class="w-full"
      :disabled="disabled"
    />
    <UBadge
      v-else
      variant="subtle"
      color="neutral"
    >
      {{ items.find(t => t.value === target)?.label ?? target }}
    </UBadge>
  </UFormField>
</template>
