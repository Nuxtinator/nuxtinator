<script setup lang="ts">
import type { AssistantProposal } from '../../composables/useContextAssistant'

defineProps<{
  proposal: AssistantProposal
  index: number
  total: number
  canApply: boolean
  busy: boolean
  showPortfolio: boolean
}>()
const emit = defineEmits<{ decide: [action: 'apply' | 'reject'] }>()
</script>

<template>
  <div
    class="border rounded-lg overflow-hidden"
    :class="proposal.status === 'applied'
      ? 'border-(--ui-success)'
      : proposal.status === 'rejected' ? 'border-(--ui-border) opacity-60' : 'border-(--ui-border)'"
  >
    <div class="px-3 py-2 bg-(--ui-bg-elevated) border-b border-(--ui-border) flex items-center justify-between gap-2">
      <div class="min-w-0 text-xs">
        <span class="font-medium">{{ proposal.section_title }}</span>
        <span v-if="showPortfolio" class="text-(--ui-text-muted)"> · {{ proposal.portfolio_name }}</span>
        <span class="text-(--ui-text-dimmed)"> · {{ index + 1 }} of {{ total }}</span>
      </div>
      <UBadge
        v-if="proposal.status === 'applied'"
        color="success"
        variant="subtle"
        size="sm"
        icon="i-lucide-check"
      >
        Applied
      </UBadge>
      <UBadge
        v-else-if="proposal.status === 'rejected'"
        color="neutral"
        variant="subtle"
        size="sm"
      >
        Rejected
      </UBadge>
    </div>

    <div class="max-h-64 overflow-auto px-3 py-2 text-xs">
      <ContextTextDiff
        :before="proposal.current_content"
        :after="proposal.proposed_content"
      />
    </div>

    <div
      v-if="proposal.status === 'pending'"
      class="px-3 py-2 border-t border-(--ui-border) bg-(--ui-bg-elevated) flex items-center gap-2"
    >
      <UButton
        v-if="canApply"
        size="xs"
        color="success"
        icon="i-lucide-check"
        :loading="busy"
        @click="emit('decide', 'apply')"
      >
        Accept
      </UButton>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        :disabled="busy"
        @click="emit('decide', 'reject')"
      >
        Reject
      </UButton>
      <span v-if="!canApply" class="text-xs text-(--ui-text-muted)">You can't apply changes.</span>
    </div>
  </div>
</template>
