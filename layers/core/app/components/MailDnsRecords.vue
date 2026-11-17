<script setup lang="ts">
import type { MailDnsRecord } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  records: MailDnsRecord[]
  grouped?: boolean
}>(), { grouped: true })

const ROLE_LABELS: Record<MailDnsRecord['role'], string> = {
  ownership: 'Ownership',
  send: 'Sending',
  receive: 'Receiving'
}

const groups = computed(() => {
  if (!props.grouped) return [{ role: null, records: props.records }]
  return (['ownership', 'send', 'receive'] as const)
    .map(role => ({ role, records: props.records.filter(r => r.role === role) }))
    .filter(g => g.records.length)
})

const statusIcon = (s?: MailDnsRecord['status']) => s === 'verified'
  ? { name: 'i-lucide-circle-check', class: 'text-(--ui-success)', label: 'Found' }
  : s === 'failed'
    ? { name: 'i-lucide-circle-x', class: 'text-(--ui-error)', label: 'Not found' }
    : { name: 'i-lucide-clock', class: 'text-(--ui-text-dimmed)', label: 'Not checked yet' }
</script>

<template>
  <div class="space-y-4">
    <div
      v-for="group in groups"
      :key="group.role ?? 'all'"
      class="space-y-2"
    >
      <h4
        v-if="group.role"
        class="text-sm font-medium"
      >
        {{ ROLE_LABELS[group.role] }}
      </h4>
      <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
        <li
          v-for="(record, i) in group.records"
          :key="`${record.type}:${record.name}:${i}`"
          class="p-3 space-y-2"
        >
          <div class="flex items-center gap-2">
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ record.type }}
            </UBadge>
            <span
              v-if="record.priority !== undefined"
              class="text-xs text-(--ui-text-muted)"
            >Priority {{ record.priority }}</span>
            <span
              v-if="record.purpose"
              class="text-xs text-(--ui-text-muted) truncate"
            >{{ record.purpose }}</span>
            <span class="ml-auto flex items-center gap-1 text-xs text-(--ui-text-muted)">
              <UIcon
                :name="statusIcon(record.status).name"
                class="size-4"
                :class="statusIcon(record.status).class"
              />
              {{ statusIcon(record.status).label }}
            </span>
          </div>
          <MailCopyValue
            label="Name"
            :value="record.name"
          />
          <MailCopyValue
            label="Value"
            :value="record.value"
          />
        </li>
      </ul>
    </div>
  </div>
</template>
