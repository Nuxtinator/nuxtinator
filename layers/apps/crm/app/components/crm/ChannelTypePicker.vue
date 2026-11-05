<script setup lang="ts">
// The schema builder's extra input for communication_channel fields
// (registered in plugins/register-crm-ui.ts): which channel type the field
// holds. Locked after the field is created.
const model = defineModel<Record<string, unknown>>({ default: () => ({}) })

defineProps<{
  readonly?: boolean
  disabled?: boolean
}>()

const { channelTypes, loadChannelTypes } = useCrmChannelTypes()

onMounted(() => {
  if (channelTypes.value.length === 0) {
    // A load failure leaves the picker empty; submit stays disabled.
    loadChannelTypes().catch(() => {})
  }
})

const items = computed(() => channelTypes.value.map(t => ({ label: t.label, value: t.key })))

const channelType = computed({
  get: () => typeof model.value.channelType === 'string' ? model.value.channelType : undefined,
  set: (v: string | undefined) => { model.value = { ...model.value, channelType: v } }
})
</script>

<template>
  <UFormField
    label="Channel type"
    :required="!readonly"
    :help="readonly ? undefined : 'Drives normalization and dedupe. Locked after the field is created.'"
  >
    <USelectMenu
      v-if="!readonly"
      v-model="channelType"
      :items="items"
      value-key="value"
      label-key="label"
      :search-input="false"
      placeholder="Pick a channel type"
      class="w-full"
      :disabled="disabled"
    />
    <UBadge
      v-else
      variant="subtle"
      color="neutral"
    >
      {{ items.find(t => t.value === channelType)?.label ?? channelType }}
    </UBadge>
  </UFormField>
</template>
