<script setup lang="ts">
// Detail-page header: back link to the list, click-to-rename name (only when
// the caller can edit this record), a status badge colored from the status
// field's option settings, the share popover (share/unshare land on the
// record's timeline, hence the shareChanged re-emit), and a confirm-gated
// delete button. `canEdit`/`canShare`/`canDelete` are the record detail's
// server-evaluated capabilities; the page owns the actual delete call, so
// `deleting` keeps the confirm modal's button spinning until it navigates
// away (or fails and closes via the page resetting the flag).
import type { RecordsFieldSetting } from '../../utils/field-kinds'
import type { RecordDetail } from '../../composables/useRecordsRecord'

const props = defineProps<{
  record: RecordDetail
  statusField: RecordsFieldSetting | null
  backTo: string
  backLabel: string
  canEdit: boolean
  canShare: boolean
  canDelete: boolean
  deleting: boolean
}>()

const emit = defineEmits<{
  rename: [name: string]
  shareChanged: []
  delete: []
}>()

const confirmOpen = ref(false)

const editing = ref(false)
const draft = ref('')
const nameInput = ref<{ inputRef?: HTMLInputElement } | null>(null)

function beginEdit() {
  if (!props.canEdit) return
  draft.value = props.record.name
  editing.value = true
  nextTick(() => nameInput.value?.inputRef?.focus())
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const next = draft.value.trim()
  if (next !== '' && next !== props.record.name) emit('rename', next)
}

function cancel() {
  editing.value = false
}

function blurTarget(event: Event) {
  (event.target as HTMLElement).blur()
}
</script>

<template>
  <div class="space-y-2">
    <NuxtLink
      :to="backTo"
      class="inline-flex items-center gap-1 text-sm text-(--ui-text-muted) hover:text-(--ui-text) transition-colors"
    >
      <UIcon
        name="i-lucide-arrow-left"
        class="size-4"
      />
      {{ backLabel }}
    </NuxtLink>

    <div class="flex items-center gap-3 flex-wrap">
      <h1
        v-if="!editing"
        class="text-2xl font-bold rounded px-1 -mx-1"
        :class="canEdit ? 'cursor-text hover:bg-(--ui-bg-elevated)' : ''"
        :title="canEdit ? 'Click to rename' : undefined"
        @click="beginEdit"
      >
        {{ record.name || '—' }}
      </h1>
      <UInput
        v-else
        ref="nameInput"
        v-model="draft"
        size="lg"
        class="w-full max-w-md"
        @blur="commit"
        @keydown.enter.prevent="blurTarget"
        @keydown.esc.prevent="cancel"
      />
      <UBadge
        v-if="statusField && record.status"
        :color="recordsOptionColor(statusField, record.status)"
        variant="subtle"
        size="lg"
      >
        {{ recordsOptionLabel(statusField, record.status) }}
      </UBadge>
      <RecordsSharePopover
        class="ml-auto"
        :record-id="record.id"
        :type-key="record.typeKey"
        :can-share="canShare"
        @changed="emit('shareChanged')"
      />
      <UButton
        v-if="canDelete"
        icon="i-lucide-trash-2"
        color="neutral"
        variant="outline"
        size="sm"
        aria-label="Delete record"
        @click="confirmOpen = true"
      />
    </div>

    <UModal
      v-model:open="confirmOpen"
      :dismissible="!deleting"
    >
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            Delete {{ record.name || 'this record' }}?
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            This permanently deletes the record and its timeline. It can't be undone.
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :disabled="deleting"
              @click="confirmOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="emit('delete')"
            >
              Delete
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
