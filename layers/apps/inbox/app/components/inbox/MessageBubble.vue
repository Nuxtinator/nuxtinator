<script setup lang="ts">
// One thread message. Inbound HTML is DOMPurify-sanitized before v-html; the
// quoted-history toggle shows the full body when it differs meaningfully from
// the provider's quote-stripped variant.
import type { InboxThreadMessage } from '../../composables/useInboxThread'

const props = defineProps<{ message: InboxThreadMessage }>()

const showFull = ref(false)

const strippedHtml = computed(() => props.message.bodyStrippedHtml || props.message.bodyHtml || '')
const fullHtml = computed(() => props.message.bodyHtml || strippedHtml.value)

// Offer the toggle only when the full body carries visibly more text than the
// stripped variant (i.e. there IS quoted history to reveal).
const hasQuoted = computed(() => {
  const strip = (h: string) => h.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return strip(fullHtml.value).length > strip(strippedHtml.value).length + 40
})

const displayHtml = computed(() =>
  inboxSanitizeDisplayHtml(showFull.value ? fullHtml.value : strippedHtml.value)
  || `<p>${(props.message.bodyText || '').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`
)

const isOutbound = computed(() => props.message.direction === 'outbound')

const statusBadge = computed(() => {
  const m = props.message
  if (m.status === 'held') return { label: 'Held', color: 'warning' as const, icon: 'i-lucide-shield-alert' }
  if (m.status === 'failed') return { label: m.failedReason ? `Failed — ${m.failedReason}` : 'Failed', color: 'error' as const, icon: 'i-lucide-x-circle' }
  if (m.status === 'delivered') return { label: 'Delivered', color: 'success' as const, icon: 'i-lucide-check-check' }
  if (m.status === 'sent') return { label: 'Sent', color: 'neutral' as const, icon: 'i-lucide-check' }
  if (m.status === 'queued') return { label: 'Sending…', color: 'neutral' as const, icon: 'i-lucide-clock' }
  return null
})
</script>

<template>
  <div
    class="rounded-lg border p-3"
    :class="[
      isOutbound ? 'bg-(--ui-bg-elevated) sm:ml-6' : 'bg-(--ui-bg) sm:mr-6',
      message.status === 'held' ? 'border-(--ui-warning)' : 'border-(--ui-border)'
    ]"
  >
    <div class="flex items-center gap-2 text-xs text-(--ui-text-muted) mb-2">
      <UIcon :name="isOutbound ? 'i-lucide-corner-up-right' : 'i-lucide-corner-down-left'" class="size-3.5" />
      <span class="font-medium text-(--ui-text) truncate">
        {{ isOutbound ? (message.senderName || 'Team') : (message.fromName || message.fromEmail) }}
      </span>
      <span v-if="!isOutbound && message.fromName" class="hidden sm:inline truncate">&lt;{{ message.fromEmail }}&gt;</span>
      <!-- Address line: which of our addresses received it / which it left on
           (outbound from_email is null on shared-address sends until queue-time
           snapshotting — nothing to show then). -->
      <span v-if="!isOutbound && message.toEmail" class="hidden md:inline truncate text-(--ui-text-dimmed)">To: {{ message.toEmail }}</span>
      <span v-if="isOutbound && message.fromEmail" class="hidden md:inline truncate text-(--ui-text-dimmed)">From: {{ message.fromEmail }}</span>
      <UTooltip v-if="!isOutbound && message.authenticated" text="Sender authenticated (DKIM/DMARC)">
        <UIcon name="i-lucide-badge-check" class="size-3.5 text-(--ui-success)" />
      </UTooltip>
      <UBadge
        v-if="message.aiGenerated"
        label="AI"
        color="info"
        variant="subtle"
        size="sm"
        icon="i-lucide-sparkles"
      />
      <span class="ml-auto shrink-0">{{ inboxRelativeTime(message.createdAt) }}</span>
    </div>

    <UAlert
      v-if="message.status === 'held'"
      icon="i-lucide-shield-alert"
      color="warning"
      variant="subtle"
      :title="message.holdReason || 'Held for review'"
      description="This sender doesn't match the conversation. Never reply with sensitive context."
      class="mb-2"
    />

    <!-- eslint-disable-next-line vue/no-v-html — sanitized via DOMPurify above -->
    <div class="inbox-message-body prose prose-sm dark:prose-invert max-w-none break-words" v-html="displayHtml" />

    <div v-if="hasQuoted" class="mt-2">
      <UButton
        :label="showFull ? 'Hide quoted text' : 'Show quoted text'"
        variant="link"
        color="neutral"
        size="xs"
        :icon="showFull ? 'i-lucide-chevron-up' : 'i-lucide-ellipsis'"
        @click="showFull = !showFull"
      />
    </div>

    <div v-if="message.attachments.length" class="flex flex-wrap gap-2 mt-3">
      <UButton
        v-for="a in message.attachments"
        :key="a.id"
        :label="a.filename || 'attachment'"
        icon="i-lucide-paperclip"
        size="xs"
        variant="subtle"
        color="neutral"
        :href="`/api/inbox/attachments/${a.id}`"
        external
      />
    </div>

    <div v-if="statusBadge" class="mt-2">
      <UBadge :label="statusBadge.label" :color="statusBadge.color" :icon="statusBadge.icon" size="sm" variant="subtle" />
    </div>
  </div>
</template>

<style scoped>
/* Wide HTML mail (tables, long unbreakable runs) scrolls inside the bubble
   instead of overflowing the thread pane. */
.inbox-message-body {
  overflow-x: auto;
}

/* Match the size cap outbound mail applies per <img> at send time
   (inboxConstrainImages), so the thread preview shows what recipients see. */
.inbox-message-body :deep(img) {
  max-width: 100%;
  max-height: 480px;
  height: auto;
}
</style>
