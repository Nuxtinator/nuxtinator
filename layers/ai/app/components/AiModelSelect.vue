<script setup lang="ts">
import type { AiModelInfo } from '#ai'
import { directProviderBadge, modelMeta } from '../utils/ai-model-meta'

// Searchable model picker over a caller-supplied list (the host-enabled set,
// the org's allowed set, or the whole model list). Each entry shows the
// model's name, id, provider, price and context window. A current
// value missing from the list is shown as unavailable rather than dropped, so
// a stale choice stays visible until it's changed.

const props = withDefaults(defineProps<{
  modelValue: string
  items: AiModelInfo[]
  placeholder?: string
  disabled?: boolean
  // Offer an explicit entry that clears the selection, labelled `clearLabel`.
  clearable?: boolean
  clearLabel?: string
}>(), {
  placeholder: 'Search models…',
  disabled: false,
  clearable: false,
  clearLabel: 'None'
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

interface Option {
  id: string
  name: string
  meta: string
  tinfoil?: boolean
  direct?: string
  transcription?: boolean
  decision?: boolean
  unavailable?: boolean
}

// The clear entry's internal value. A combobox item may not carry '' (reka-ui
// reserves it for "nothing selected"), so '' on the model side is mapped to
// this sentinel inside the menu and back on emit. Model ids are
// `vendor/model`, so it can't collide.
const CLEAR_VALUE = '__clear__'

const options = computed<Option[]>(() => {
  const out: Option[] = props.items.map(m => ({
    id: m.id,
    name: m.name,
    meta: modelMeta(m),
    tinfoil: m.provider === 'tinfoil',
    direct: directProviderBadge(m.provider),
    transcription: m.kind === 'transcription',
    decision: m.kind === 'decision'
  }))
  if (props.modelValue && !props.items.some(m => m.id === props.modelValue)) {
    out.unshift({ id: props.modelValue, name: props.modelValue, meta: 'No longer available', unavailable: true })
  }
  if (props.clearable) {
    out.unshift({ id: CLEAR_VALUE, name: props.clearLabel, meta: '' })
  }
  return out
})

const selected = computed(() => props.modelValue || (props.clearable ? CLEAR_VALUE : ''))

function onUpdate(value: unknown) {
  const id = typeof value === 'string' ? value : ''
  emit('update:modelValue', id === CLEAR_VALUE ? '' : id)
}
</script>

<template>
  <USelectMenu
    :model-value="selected"
    :items="options"
    value-key="id"
    label-key="name"
    :filter-fields="['name', 'id']"
    :placeholder="placeholder"
    :disabled="disabled"
    :search-input="{ placeholder: 'Search by name or id…' }"
    :ui="{ content: 'min-w-80' }"
    @update:model-value="onUpdate"
  >
    <template #item-label="{ item }">
      <div class="min-w-0 flex-1 py-0.5">
        <div class="flex items-center gap-2">
          <span class="truncate">{{ item.name }}</span>
          <UBadge
            v-if="item.unavailable"
            color="warning"
            variant="subtle"
            size="sm"
          >
            Unavailable
          </UBadge>
          <UBadge
            v-if="item.tinfoil"
            color="success"
            variant="subtle"
            size="sm"
            icon="i-lucide-shield-check"
          >
            Tinfoil
          </UBadge>
          <UBadge
            v-if="item.direct"
            color="neutral"
            variant="subtle"
            size="sm"
          >
            {{ item.direct }}
          </UBadge>
          <UBadge
            v-if="item.transcription"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-audio-lines"
          >
            Transcription
          </UBadge>
          <UBadge
            v-if="item.decision"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-split"
          >
            Decision
          </UBadge>
        </div>
        <div
          v-if="item.id !== CLEAR_VALUE"
          class="text-xs text-(--ui-text-muted) font-mono truncate"
        >
          {{ item.id }}
        </div>
        <div
          v-if="item.meta"
          class="text-xs text-(--ui-text-muted)"
        >
          {{ item.meta }}
        </div>
      </div>
    </template>
  </USelectMenu>
</template>
