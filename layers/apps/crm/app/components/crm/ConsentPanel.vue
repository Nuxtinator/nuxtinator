<script setup lang="ts">
// Per-channel consent editor in a slideover: capture context (source select +
// optional note, applied to the next change), one opt-in/opt-out toggle row
// per code-registered purpose, and the channel's recent compliance events
// below. When the caller lacks edit capability the panel is read-only: the
// capture-context block and grant/revoke buttons give way to plain status
// badges; state and history stay visible. Reads and writes through the
// record consent endpoints; emits 'refresh' after every successful change so
// the opener updates its badges.
import type {
  CrmChannelConsentInfo,
  CrmConsentPurposeInfo,
  CrmConsentSource,
  CrmConsentStatus
} from '../../composables/useCrmChannels'
import { CRM_CONSENT_SOURCES } from '../../composables/useCrmChannels'

const props = defineProps<{
  typeKey: string
  recordId: string
  /** Channel the panel edits; null renders an empty (closed) panel. */
  channelId: string | null
  /** The record detail's canEdit capability — false renders read-only. */
  editable: boolean
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  refresh: []
}>()

const toast = useToast()
const { fetchConsent, setConsent } = useCrmChannels(() => props.typeKey, () => props.recordId)

const purposes = ref<CrmConsentPurposeInfo[]>([])
const channel = ref<CrmChannelConsentInfo | null>(null)
const loading = ref(false)
/** Purpose key with a request in flight, or null. */
const saving = ref<string | null>(null)

const source = ref<CrmConsentSource>('verbal')
const note = ref('')

async function load() {
  if (!props.channelId) return
  loading.value = true
  try {
    const res = await fetchConsent()
    purposes.value = res.purposes
    channel.value = res.channels.find(c => c.channelId === props.channelId) ?? null
  } catch (err) {
    toast.add({
      title: 'Failed to load consent',
      description: recordsErrorMessage(err, 'Failed to load consent'),
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

watch([open, () => props.channelId], ([isOpen]) => {
  if (isOpen) load()
})

const events = computed(() => channel.value?.events ?? [])

function statusOf(purposeKey: string): CrmConsentStatus | null {
  return channel.value?.consents.find(c => c.purpose === purposeKey)?.status ?? null
}

function purposeTitle(purposeKey: string): string {
  return purposes.value.find(p => p.key === purposeKey)?.title ?? purposeKey
}

async function apply(purposeKey: string, status: CrmConsentStatus) {
  if (!props.channelId || saving.value) return
  saving.value = purposeKey
  try {
    const res = await setConsent({
      channelId: props.channelId,
      purpose: purposeKey,
      status,
      source: source.value,
      note: note.value.trim() || undefined
    })
    if (channel.value) {
      channel.value = { ...channel.value, consents: res.consents, suppressed: res.suppressed }
    }
    note.value = ''
    // Re-read so the event list below reflects the change.
    await load()
    emit('refresh')
  } catch (err) {
    toast.add({
      title: 'Consent update failed',
      description: recordsErrorMessage(err, 'Failed to update consent'),
      color: 'error'
    })
  } finally {
    saving.value = null
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="channel?.value ?? 'Consent'"
    description="Per-purpose communication consent for this address."
  >
    <template #body>
      <div
        v-if="loading && !channel"
        class="grid place-items-center py-12 text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-5 animate-spin"
        />
      </div>

      <div
        v-else
        class="space-y-6"
      >
        <UAlert
          v-if="channel?.suppressed"
          color="warning"
          icon="i-lucide-octagon-x"
          title="Delivery suppressed"
          description="Messages to this address are blocked regardless of consent."
        />

        <div
          v-if="editable"
          class="space-y-2"
        >
          <p class="text-xs font-medium text-(--ui-text-muted) uppercase tracking-wide">
            Capture context
          </p>
          <div class="flex gap-2">
            <USelect
              v-model="source"
              :items="CRM_CONSENT_SOURCES"
              class="w-32"
              size="sm"
              aria-label="Consent source"
            />
            <UInput
              v-model="note"
              placeholder="Note (optional)"
              class="flex-1"
              size="sm"
            />
          </div>
          <p class="text-xs text-(--ui-text-muted)">
            Recorded with the next opt-in / opt-out below.
          </p>
        </div>

        <div class="divide-y divide-(--ui-border)">
          <div
            v-for="purpose in purposes"
            :key="purpose.key"
            class="flex items-center justify-between gap-3 py-3"
          >
            <div class="min-w-0">
              <p class="text-sm font-medium">
                {{ purpose.title }}
              </p>
              <p
                v-if="purpose.description"
                class="text-xs text-(--ui-text-muted)"
              >
                {{ purpose.description }}
              </p>
            </div>
            <div
              v-if="editable"
              class="flex gap-1 shrink-0"
            >
              <UButton
                label="Opt-in"
                size="xs"
                color="success"
                :variant="statusOf(purpose.key) === 'opt_in' ? 'solid' : 'outline'"
                :loading="saving === purpose.key"
                @click="apply(purpose.key, 'opt_in')"
              />
              <UButton
                label="Opt-out"
                size="xs"
                color="error"
                :variant="statusOf(purpose.key) === 'opt_out' ? 'solid' : 'outline'"
                :loading="saving === purpose.key"
                @click="apply(purpose.key, 'opt_out')"
              />
            </div>
            <UBadge
              v-else
              :color="statusOf(purpose.key) === 'opt_in' ? 'success' : statusOf(purpose.key) === 'opt_out' ? 'error' : 'neutral'"
              variant="subtle"
              size="sm"
              class="shrink-0"
            >
              {{ statusOf(purpose.key) === 'opt_in' ? 'Opt-in' : statusOf(purpose.key) === 'opt_out' ? 'Opt-out' : 'No consent' }}
            </UBadge>
          </div>
        </div>

        <div class="space-y-2">
          <p class="text-xs font-medium text-(--ui-text-muted) uppercase tracking-wide">
            History
          </p>
          <p
            v-if="events.length === 0"
            class="text-sm text-(--ui-text-muted)"
          >
            No consent events yet.
          </p>
          <ul
            v-else
            class="space-y-1.5"
          >
            <li
              v-for="e in events"
              :key="e.id"
              class="text-sm flex items-baseline gap-2"
            >
              <UBadge
                :color="e.event === 'grant' ? 'success' : 'error'"
                variant="subtle"
                size="sm"
              >
                {{ e.event === 'grant' ? 'Opt-in' : 'Opt-out' }}
              </UBadge>
              <span class="truncate">{{ purposeTitle(e.purpose) }}</span>
              <span
                v-if="e.source"
                class="text-(--ui-text-muted)"
              >via {{ e.source }}</span>
              <span class="text-xs text-(--ui-text-muted) ml-auto shrink-0">
                {{ new Date(e.occurredAt).toLocaleString() }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </USlideover>
</template>
