<script setup lang="ts">
// Injected onto the CRM record detail page (after the connections panel) via
// the crm detail-panel registry. Shows every inbox thread across the record's
// linked email addresses, an inline quick-reply per active thread, and a
// compose-new button locked to the record's email. Self-gates on inbox.access:
// a caller without it (or a 403 from the endpoint) sees nothing at all — the
// panel is permission-hidden, never permission-erroring.
import type { InboxRecordConversationRow } from '../../composables/useInboxRecordConversations'

const props = defineProps<{ recordId: string, recordType?: string }>()

const { hasPermission } = usePermissions()
const canAccess = computed(() => hasPermission('inbox.access'))
const canSend = computed(() => hasPermission('inbox.send'))

const inboxPath = useInboxPath()
const toast = useToast()

const { items, channels, total, pending, denied, refresh } = useInboxRecordConversations(() => props.recordId)
const { me } = useInboxMe()

const showCompose = ref(false)
const composeChannel = computed(() => channels.value[0] ?? null)

// Inline quick-reply state (one open row at a time). The From choice matches
// the reply composer's; personal is the default when the agent has an alias
// (mirroring new-compose — the quick reply is usually a personal touch).
const replyingId = ref<string | null>(null)
const replyText = ref('')
const replySending = ref(false)
const fromIdentity = ref<'personal' | 'contact'>('contact')
const fromOptions = computed(() => {
  const opts: { label: string, value: 'personal' | 'contact' }[] = []
  if (me.value?.personalFrom) opts.push({ label: `You · ${me.value.personalFrom}`, value: 'personal' })
  opts.push({ label: `${me.value?.brandFromName || 'Shared'} · ${me.value?.contactAddress ?? 'contact address'}`, value: 'contact' })
  return opts
})

function startReply(id: string) {
  replyingId.value = id
  replyText.value = ''
  fromIdentity.value = me.value?.personalFrom ? 'personal' : 'contact'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The server sanitizes but does not add structure, so a plain textarea would
// arrive as one line — convert newlines to markup client-side.
function toMarkup(text: string): string {
  return `<p>${text.split('\n').map(escapeHtml).join('<br>')}</p>`
}

async function sendReply(id: string) {
  const text = replyText.value.trim()
  if (!text) return
  replySending.value = true
  try {
    const url: string = `/api/inbox/conversations/${id}/messages`
    await $fetch(url, {
      method: 'POST',
      body: {
        body: toMarkup(text),
        ...(me?.value?.personalFrom ? { fromIdentity: fromIdentity.value } : {})
      }
    })
    replyingId.value = null
    replyText.value = ''
    await refresh()
    toast.add({ title: 'Reply queued', icon: 'i-lucide-send', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Reply failed', description: err instanceof Error ? err.message : undefined, color: 'error' })
  } finally {
    replySending.value = false
  }
}

function onComposed() {
  refresh()
}

function statusMeta(row: InboxRecordConversationRow) {
  return INBOX_STATUS_META[row.status] ?? { label: row.status, color: 'neutral' as const }
}
</script>

<template>
  <section v-if="canAccess && !denied" class="space-y-2">
    <div class="flex items-center justify-between px-1">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-(--ui-text-muted)">
        Conversations
      </h2>
      <UButton
        v-if="canSend && composeChannel"
        label="New email"
        icon="i-lucide-pen-line"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="showCompose = true"
      />
    </div>

    <div class="border border-(--ui-border) rounded-lg divide-y divide-(--ui-border) bg-(--ui-bg)">
      <div v-if="pending && !items.length" class="px-4 py-6 grid place-items-center text-(--ui-text-muted)">
        <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
      </div>
      <p v-else-if="!items.length" class="px-4 py-4 text-sm text-(--ui-text-dimmed)">
        No conversations with this contact yet.
      </p>

      <div v-for="row in items" :key="row.id" class="px-4 py-3 space-y-1.5">
        <div class="flex items-center gap-2 min-w-0">
          <NuxtLink
            :to="inboxPath(`/inbox/${row.id}`)"
            class="font-medium text-sm truncate flex-1 text-(--ui-text-highlighted) hover:underline"
          >
            {{ row.subject || '(no subject)' }}
          </NuxtLink>
          <UBadge :label="statusMeta(row).label" :color="statusMeta(row).color" size="sm" variant="subtle" />
          <span class="text-xs text-(--ui-text-dimmed) shrink-0">{{ inboxRelativeTime(row.lastMessageAt || row.createdAt) }}</span>
        </div>
        <p v-if="row.snippet" class="text-xs text-(--ui-text-dimmed) truncate">{{ row.snippet }}</p>
        <div class="flex items-center gap-2 text-xs text-(--ui-text-muted)">
          <span class="truncate">{{ row.channelValue }}</span>
          <span v-if="row.assigneeName" class="flex items-center gap-1 shrink-0 text-(--ui-text-dimmed)">
            <UIcon name="i-lucide-user-check" class="size-3" />
            {{ row.assigneeName }}
          </span>
          <!-- Quick-reply is hidden on spam rows (the thread is closed silently). -->
          <UButton
            v-if="canSend && row.status !== 'spam' && replyingId !== row.id"
            label="Reply"
            icon="i-lucide-reply"
            size="xs"
            color="neutral"
            variant="ghost"
            class="ml-auto"
            @click="startReply(row.id)"
          />
        </div>

        <div v-if="replyingId === row.id" class="space-y-2 pt-1">
          <UTextarea
            v-model="replyText"
            :rows="3"
            autoresize
            placeholder="Write a reply…"
            class="w-full"
            autofocus
          />
          <div class="flex items-center justify-end gap-2">
            <USelect
              v-if="fromOptions.length > 1"
              v-model="fromIdentity"
              :items="fromOptions"
              size="xs"
              class="w-56 mr-auto"
            />
            <UButton label="Cancel" size="xs" color="neutral" variant="ghost" @click="replyingId = null" />
            <UButton
              label="Send"
              icon="i-lucide-send"
              size="xs"
              :loading="replySending"
              :disabled="!replyText.trim()"
              @click="sendReply(row.id)"
            />
          </div>
        </div>
      </div>

      <p v-if="total > items.length" class="px-4 py-2 text-xs text-(--ui-text-dimmed)">
        Showing the latest {{ items.length }} of {{ total }} conversations
      </p>
    </div>

    <InboxComposeModal
      v-if="composeChannel"
      v-model:open="showCompose"
      :locked-recipient="{ channelId: composeChannel.channelId, label: composeChannel.value }"
      @created="onComposed"
    />
  </section>
</template>
