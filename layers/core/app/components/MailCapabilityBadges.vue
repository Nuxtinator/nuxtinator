<script setup lang="ts">
import type { MailCapabilities, MailCapabilityKey } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  capabilities: MailCapabilities
  keys?: MailCapabilityKey[]
}>(), { keys: () => ['send', 'domains', 'routes', 'webhooks', 'suppressionLists'] })

const items = computed(() => props.keys.map((key) => {
  const value = props.capabilities[key]
  return {
    key,
    label: MAIL_CAPABILITY_LABELS[key],
    value,
    icon: value === true ? 'i-lucide-check' : value === false ? 'i-lucide-x' : 'i-lucide-circle-dashed',
    color: (value === true ? 'success' : value === false ? 'error' : 'neutral') as 'success' | 'error' | 'neutral',
    title: value === true ? 'Allowed' : value === false ? 'Not allowed' : 'Not tested yet'
  }
}))
</script>

<template>
  <div class="flex flex-wrap gap-1">
    <UBadge
      v-for="item in items"
      :key="item.key"
      :color="item.color"
      variant="subtle"
      size="sm"
      :leading-icon="item.icon"
      :title="item.title"
      :class="item.value === undefined ? 'text-(--ui-text-dimmed)' : ''"
    >
      {{ item.label }}<span
        v-if="item.value === undefined"
        class="sr-only"
      > not tested</span>
    </UBadge>
  </div>
</template>
