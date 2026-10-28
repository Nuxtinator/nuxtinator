<script setup lang="ts">
// Channel-field editor for the record detail page: one row per linked
// address with primary star, label badge, verified icon, consent badge
// (click opens the consent panel), inline edit, and remove — plus an
// add-entry form. When the caller lacks edit capability the widget renders
// read-only: no add/edit/remove/primary controls, a static star marks the
// primary entry, and the consent panel opens without grant/revoke buttons.
// Mutations go through the record channel routes and emit 'refresh' so the
// page refetches the record; the consent overview is fetched here once and
// reloaded after changes.
import type { CrmChannelEntry } from '#crm'
import type { CrmFieldSetting } from '../../utils/field-kinds'
import type { CrmChannelConsentInfo } from '../../composables/useCrmChannels'

const props = defineProps<{
  recordId: string
  typeKey: string
  field: CrmFieldSetting
  entries: CrmChannelEntry[]
  /** The record detail's canEdit capability — false renders read-only. */
  editable: boolean
  /** The addresses come from a linked user account: consent stays editable, the addresses don't. */
  addressesLocked?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const canChangeAddresses = computed(() => props.editable && !props.addressesLocked)

const toast = useToast()
const { addChannel, updateChannel, removeChannel, fetchConsent } = useCrmChannels(
  () => props.typeKey,
  () => props.recordId
)

// --- Consent badges ---------------------------------------------------------

const consentByChannel = ref<Record<string, CrmChannelConsentInfo>>({})

async function loadConsent() {
  try {
    const res = await fetchConsent()
    consentByChannel.value = Object.fromEntries(res.channels.map(c => [c.channelId, c]))
  } catch {
    // Badges fall back to "No consent" when the overview can't load.
  }
}
onMounted(loadConsent)

const panelOpen = ref(false)
const panelChannelId = ref<string | null>(null)

function openConsent(entry: CrmChannelEntry) {
  panelChannelId.value = entry.channelId
  panelOpen.value = true
}

// Consent changes update the badges here and write consent_changed activity
// rows, so the parent gets the same refresh signal as channel mutations.
function onConsentChanged() {
  loadConsent()
  emit('refresh')
}

// --- Mutations ---------------------------------------------------------------

const busy = ref(false)

async function run(action: () => Promise<unknown>, failTitle: string) {
  if (busy.value) return false
  busy.value = true
  try {
    await action()
    emit('refresh')
    loadConsent()
    return true
  } catch (err) {
    toast.add({
      title: failTitle,
      description: crmErrorMessage(err, failTitle),
      color: 'error'
    })
    return false
  } finally {
    busy.value = false
  }
}

const draftValue = ref('')
const draftLabel = ref('')

const placeholder = computed(() => {
  switch (props.field.channelType) {
    case 'email':
      return 'name@example.com'
    case 'phone':
      return '+1 555 000 1111'
    default:
      return 'Value'
  }
})

async function add() {
  const value = draftValue.value.trim()
  if (value === '' || !props.field.channelType) return
  const ok = await run(() => addChannel({
    channelTypeKey: props.field.channelType!,
    fieldKey: props.field.key,
    value,
    label: draftLabel.value.trim() || undefined
  }), 'Add failed')
  if (ok) {
    draftValue.value = ''
    draftLabel.value = ''
  }
}

const editingId = ref<string | null>(null)
const editValue = ref('')
const editLabel = ref('')

function startEdit(entry: CrmChannelEntry) {
  editingId.value = entry.linkId
  editValue.value = entry.value
  editLabel.value = entry.label ?? ''
}

async function saveEdit(entry: CrmChannelEntry) {
  const value = editValue.value.trim()
  const label = editLabel.value.trim() || null
  const body: { value?: string, label?: string | null } = {}
  if (value !== '' && value !== entry.value) body.value = value
  if (label !== (entry.label ?? null)) body.label = label
  if (Object.keys(body).length === 0) {
    editingId.value = null
    return
  }
  const ok = await run(() => updateChannel(entry.linkId, body), 'Update failed')
  if (ok) editingId.value = null
}

function togglePrimary(entry: CrmChannelEntry) {
  run(() => updateChannel(entry.linkId, { primary: !entry.isPrimary }), 'Update failed')
}

function remove(entry: CrmChannelEntry) {
  run(() => removeChannel(entry.linkId), 'Remove failed')
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="entry in entries"
      :key="entry.linkId"
      class="flex items-center gap-2"
    >
      <template v-if="canChangeAddresses && editingId === entry.linkId">
        <UInput
          v-model="editValue"
          class="flex-1 sm:max-w-xs"
          size="sm"
          :placeholder="placeholder"
          @keydown.enter.prevent="saveEdit(entry)"
        />
        <UInput
          v-model="editLabel"
          placeholder="Label"
          class="w-28"
          size="sm"
          @keydown.enter.prevent="saveEdit(entry)"
        />
        <UButton
          icon="i-lucide-check"
          size="xs"
          variant="soft"
          :disabled="busy"
          aria-label="Save"
          @click="saveEdit(entry)"
        />
        <UButton
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="neutral"
          aria-label="Cancel"
          @click="editingId = null"
        />
      </template>
      <template v-else>
        <UButton
          v-if="canChangeAddresses"
          icon="i-lucide-star"
          size="xs"
          variant="ghost"
          :color="entry.isPrimary ? 'warning' : 'neutral'"
          :class="entry.isPrimary ? '' : 'opacity-40 hover:opacity-100'"
          :aria-label="entry.isPrimary ? 'Unset primary' : 'Make primary'"
          @click="togglePrimary(entry)"
        />
        <UIcon
          v-else-if="entry.isPrimary"
          name="i-lucide-star"
          class="size-4 text-(--ui-warning) shrink-0"
          aria-label="Primary"
        />
        <span class="text-sm truncate">{{ entry.value }}</span>
        <UBadge
          v-if="entry.label"
          color="neutral"
          variant="subtle"
          size="sm"
        >
          {{ entry.label }}
        </UBadge>
        <UTooltip
          v-if="entry.verified"
          text="Verified"
        >
          <UIcon
            name="i-lucide-badge-check"
            class="size-4 text-(--ui-success) shrink-0"
          />
        </UTooltip>
        <button
          type="button"
          class="shrink-0"
          :aria-label="`Consent for ${entry.value}`"
          @click="openConsent(entry)"
        >
          <CrmConsentBadge
            :consents="consentByChannel[entry.channelId]?.consents ?? []"
            :suppressed="consentByChannel[entry.channelId]?.suppressed"
          />
        </button>
        <span class="flex-1" />
        <UButton
          v-if="canChangeAddresses"
          icon="i-lucide-pencil"
          size="xs"
          variant="ghost"
          color="neutral"
          :aria-label="`Edit ${entry.value}`"
          @click="startEdit(entry)"
        />
        <UButton
          v-if="canChangeAddresses"
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="neutral"
          :aria-label="`Remove ${entry.value}`"
          @click="remove(entry)"
        />
      </template>
    </div>

    <p
      v-if="!canChangeAddresses && entries.length === 0"
      class="text-sm sm:pt-1.5 text-(--ui-text-muted)"
    >
      —
    </p>

    <div
      v-if="canChangeAddresses"
      class="flex gap-2"
    >
      <UInput
        v-model="draftValue"
        :placeholder="placeholder"
        class="flex-1 sm:max-w-xs"
        @keydown.enter.prevent="add"
      />
      <UInput
        v-model="draftLabel"
        placeholder="Label (optional)"
        class="w-36"
        @keydown.enter.prevent="add"
      />
      <UButton
        icon="i-lucide-plus"
        variant="soft"
        :disabled="draftValue.trim() === '' || busy"
        aria-label="Add channel"
        @click="add"
      />
    </div>

    <CrmConsentPanel
      v-model:open="panelOpen"
      :type-key="typeKey"
      :record-id="recordId"
      :channel-id="panelChannelId"
      :editable="editable"
      @refresh="onConsentChanged"
    />
  </div>
</template>
