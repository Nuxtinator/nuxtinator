<script setup lang="ts">
import type { AiModelInfo } from '#ai'
import { modelMeta } from '../utils/ai-model-meta'

// A bordered list of models with their badges, id and price line, optionally
// with a remove button per row. `available: false` marks a model its provider
// no longer lists.

type Row = AiModelInfo & { available?: boolean }

withDefaults(defineProps<{
  models: Row[]
  removable?: boolean
  disabled?: boolean
}>(), {
  removable: false,
  disabled: false
})

const emit = defineEmits<{ remove: [model: Row] }>()
</script>

<template>
  <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
    <li
      v-for="model in models"
      :key="model.id"
      class="flex items-center justify-between gap-3 p-4"
    >
      <div class="min-w-0">
        <div class="font-medium flex items-center gap-2 flex-wrap">
          {{ model.name }}
          <UBadge
            v-if="model.available === false"
            color="warning"
            variant="subtle"
            size="sm"
          >
            No longer available
          </UBadge>
          <UBadge
            v-if="model.supportsCaching"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-database"
          >
            Prompt caching
          </UBadge>
          <UBadge
            v-if="model.kind === 'transcription'"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-audio-lines"
          >
            Transcription
          </UBadge>
          <UBadge
            v-if="model.kind === 'decision'"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-split"
          >
            Decision
          </UBadge>
        </div>
        <div class="text-xs text-(--ui-text-muted) font-mono break-all">
          {{ model.id }}
        </div>
        <div
          v-if="model.available !== false"
          class="text-xs text-(--ui-text-muted)"
        >
          {{ modelMeta(model) }}
        </div>
      </div>
      <UButton
        v-if="removable"
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        aria-label="Disable model"
        @click="emit('remove', model)"
      />
    </li>
  </ul>
</template>
