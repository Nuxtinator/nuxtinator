<script setup lang="ts">
// The TXT record an org adds to prove it controls a domain, with Check now.
withDefaults(defineProps<{
  record: { type: string, name: string, value: string }
  checking?: boolean
  failed?: boolean
  // Off when the caller offers Check now itself
  showCheck?: boolean
}>(), { showCheck: true })
defineEmits<{ check: [] }>()
</script>

<template>
  <div class="space-y-3">
    <div class="border border-(--ui-border) rounded-md p-3 space-y-2">
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ record.type }}
      </UBadge>
      <MailCopyValue
        label="Name"
        :value="record.name"
      />
      <MailCopyValue
        label="Value"
        :value="record.value"
      />
    </div>
    <p
      v-if="failed"
      class="text-sm text-(--ui-error)"
    >
      The record wasn't found yet.
    </p>
    <div
      v-if="showCheck"
      class="flex items-center gap-3"
    >
      <UButton
        icon="i-lucide-refresh-cw"
        :loading="checking"
        @click="$emit('check')"
      >
        Check now
      </UButton>
      <span class="text-sm text-(--ui-text-muted)">Waiting for the record. DNS changes can take a few hours.</span>
    </div>
  </div>
</template>
