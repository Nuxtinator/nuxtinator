<script setup lang="ts">
// Merged channel-type catalog (code-registered + admin-created) with an
// inline add form and per-row delete for custom types. Channel types are
// org-global — a new one is immediately available to communication_channel
// fields and the channel widget. The value format is one of the five
// code-owned normalization formats and is locked after create.
import type { CrmChannelValueFormat } from '../../../composables/useCrmChannelTypes'

const { channelTypes, loadChannelTypes, createChannelType, deleteChannelType } = useCrmChannelTypes()

const loadError = ref<string | null>(null)
onMounted(async () => {
  try {
    await loadChannelTypes()
  } catch (err) {
    loadError.value = recordsErrorMessage(err, 'Failed to load channel types')
  }
})

const FORMAT_ITEMS: Array<{ label: string, value: CrmChannelValueFormat }> = [
  { label: 'Email address', value: 'email' },
  { label: 'Phone number', value: 'phone' },
  { label: 'Handle', value: 'handle' },
  { label: 'URL', value: 'url' },
  { label: 'Free-form', value: 'freeform' }
]

function formatLabel(format: string): string {
  return FORMAT_ITEMS.find(f => f.value === format)?.label ?? format
}

const adding = ref(false)
const newLabel = ref('')
const newKey = ref('')
const keyTouched = ref(false)
const newFormat = ref<CrmChannelValueFormat>('freeform')
const newIcon = ref<string | null>(null)
const saving = ref(false)
const saveError = ref<string | null>(null)

watch(newLabel, (v) => {
  if (!keyTouched.value) newKey.value = recordsSlugify(v)
})

function startAdd() {
  adding.value = true
  newLabel.value = ''
  newKey.value = ''
  keyTouched.value = false
  newFormat.value = 'freeform'
  newIcon.value = null
  saveError.value = null
}

const keyValid = computed(() => RECORDS_SLUG_CLIENT_RE.test(newKey.value))
const canAdd = computed(() => newLabel.value.trim().length > 0 && keyValid.value)

async function submit() {
  if (!canAdd.value || saving.value) return
  saving.value = true
  saveError.value = null
  try {
    await createChannelType({
      typeKey: newKey.value,
      label: newLabel.value.trim(),
      valueFormat: newFormat.value,
      icon: newIcon.value ?? undefined
    })
    adding.value = false
  } catch (err) {
    saveError.value = recordsErrorMessage(err, 'Failed to create channel type')
  } finally {
    saving.value = false
  }
}

// Two-step delete for custom channel types (code-registered ones have no
// delete affordance). The server 409s while claimed addresses of the type
// still exist — their consent history hangs off them.
const confirmingDeleteKey = ref<string | null>(null)
const deletingKey = ref<string | null>(null)
const deleteError = ref<string | null>(null)

async function removeType(key: string) {
  if (confirmingDeleteKey.value !== key) {
    confirmingDeleteKey.value = key
    return
  }
  deletingKey.value = key
  deleteError.value = null
  try {
    await deleteChannelType(key)
  } catch (err) {
    deleteError.value = recordsErrorMessage(err, 'Failed to delete channel type')
  } finally {
    deletingKey.value = null
    confirmingDeleteKey.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="loadError"
      color="error"
      :title="loadError"
    />

    <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
      <li
        v-for="channelType in channelTypes"
        :key="channelType.key"
        class="flex items-center gap-3 px-3 py-2"
      >
        <UIcon
          :name="channelType.icon ?? 'i-lucide-radio'"
          class="size-4 shrink-0 text-(--ui-text-muted)"
        />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium truncate">{{ channelType.label }}</span>
            <UBadge
              v-if="channelType.custom"
              variant="subtle"
              color="primary"
              size="sm"
            >
              Custom
            </UBadge>
          </div>
          <span class="text-xs text-(--ui-text-muted) font-mono">{{ channelType.key }}</span>
        </div>
        <UBadge
          variant="subtle"
          color="neutral"
          size="sm"
          class="shrink-0"
        >
          {{ formatLabel(channelType.valueFormat) }}
        </UBadge>
        <UButton
          v-if="channelType.custom"
          :color="confirmingDeleteKey === channelType.key ? 'error' : 'neutral'"
          variant="ghost"
          size="xs"
          class="shrink-0"
          :loading="deletingKey === channelType.key"
          :aria-label="`Delete ${channelType.label}`"
          @click="removeType(channelType.key)"
        >
          {{ confirmingDeleteKey === channelType.key ? 'Really delete?' : 'Delete' }}
        </UButton>
      </li>
      <li
        v-if="channelTypes.length === 0 && !loadError"
        class="px-3 py-6 text-sm text-(--ui-text-muted) text-center"
      >
        No channel types yet.
      </li>
    </ul>

    <UAlert
      v-if="deleteError"
      color="error"
      :title="deleteError"
    />

    <form
      v-if="adding"
      class="space-y-3 border border-(--ui-border) rounded-md p-3"
      @submit.prevent="submit"
    >
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <UFormField
          label="Label"
          required
        >
          <UInput
            v-model="newLabel"
            placeholder="WhatsApp"
            class="w-full"
            autofocus
            :disabled="saving"
          />
        </UFormField>
        <UFormField
          label="Key"
          required
          :error="newKey !== '' && !keyValid ? 'Must match [a-z][a-z0-9_]{1,40}' : undefined"
        >
          <UInput
            v-model="newKey"
            class="w-full font-mono"
            :disabled="saving"
            @input="keyTouched = true"
          />
        </UFormField>
        <UFormField
          label="Value format"
          help="Drives normalization and dedupe. Locked after create."
        >
          <USelectMenu
            v-model="newFormat"
            :items="FORMAT_ITEMS"
            value-key="value"
            label-key="label"
            :search-input="false"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UFormField label="Icon">
          <IconPicker
            v-model="newIcon"
            :collections="['lucide', 'simple-icons']"
            :disabled="saving"
          />
        </UFormField>
      </div>

      <UAlert
        v-if="saveError"
        color="error"
        :title="saveError"
      />

      <div class="flex gap-2 justify-end">
        <UButton
          variant="ghost"
          :disabled="saving"
          @click="adding = false"
        >
          Cancel
        </UButton>
        <UButton
          type="submit"
          :loading="saving"
          :disabled="!canAdd"
        >
          Add channel type
        </UButton>
      </div>
    </form>
    <UButton
      v-else
      icon="i-lucide-plus"
      variant="soft"
      size="sm"
      @click="startAdd"
    >
      Add channel type
    </UButton>
  </div>
</template>
