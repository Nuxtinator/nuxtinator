<script setup lang="ts">
// Deliverability suppression manager: the addresses the org can no longer mail
// (hard bounces, complaints, manual blocks), why, and who they belong to. Admins
// get an "Un-suppress" action — the recovery path for a false-positive bounce.
import type { InboxSuppression } from '../../composables/useInboxSuppressions'

const props = defineProps<{ canClear: boolean }>()
const open = defineModel<boolean>('open', { required: true })

const { items, pending, error, refresh, clear } = useInboxSuppressions()
const toast = useToast()
const clearing = ref<string | null>(null)

watch(open, (v) => { if (v) refresh() })

const REASON_META: Record<string, { label: string, color: 'error' | 'warning' | 'neutral' }> = {
  hard_bounce: { label: 'Hard bounce', color: 'error' },
  complaint: { label: 'Complaint', color: 'error' },
  manual: { label: 'Manual block', color: 'warning' }
}
function reasonMeta(reason: string) {
  return REASON_META[reason] ?? { label: reason, color: 'neutral' as const }
}

async function onClear(s: InboxSuppression) {
  clearing.value = s.channelId
  try {
    await clear(s.channelId)
    toast.add({ title: 'Suppression cleared', icon: 'i-lucide-mail-check', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Clear failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    clearing.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Suppressed addresses" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="min-h-40">
        <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-2" />
        <div v-if="pending && !items.length" class="grid place-items-center py-10 text-(--ui-text-muted)">
          <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        </div>
        <p v-else-if="!items.length" class="text-sm text-(--ui-text-dimmed) text-center py-10">
          No suppressed addresses — every address is currently mailable.
        </p>
        <div v-else class="divide-y divide-(--ui-border)">
          <div v-for="s in items" :key="s.channelId" class="py-2.5 flex items-start gap-3">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-sm text-(--ui-text-highlighted) truncate">{{ s.value }}</span>
                <UBadge :label="reasonMeta(s.reason).label" :color="reasonMeta(s.reason).color" size="sm" variant="subtle" />
              </div>
              <p v-if="s.recordNames.length" class="text-xs text-(--ui-text-muted) truncate">{{ s.recordNames.join(', ') }}</p>
              <p v-if="s.detail" class="text-xs text-(--ui-text-dimmed) truncate">{{ s.detail }}</p>
              <p class="text-xs text-(--ui-text-dimmed)">Since {{ new Date(s.since).toLocaleDateString() }}<span v-if="s.source"> · {{ s.source }}</span></p>
            </div>
            <UButton
              v-if="canClear && s.clearable"
              label="Un-suppress"
              icon="i-lucide-mail-check"
              size="xs"
              color="neutral"
              variant="subtle"
              :loading="clearing === s.channelId"
              @click="onClear(s)"
            />
            <span v-else-if="canClear" class="text-xs text-(--ui-text-dimmed) shrink-0">Cleared by a host admin</span>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
