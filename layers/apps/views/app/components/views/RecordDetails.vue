<script setup lang="ts">
// Card click target: the record's details over the whole screen, rendered by
// the records layer's own detail view, so fields, comments, sharing,
// permissions and validation are exactly the record page's. The header adds
// a star that makes the card one of the caller's favorites, opening on this
// view, and a link to the record's page. At the end of the fields sidebar, a section named after the
// view holds the view's own fields: everyone who opens the view sees the ones
// with a value, and its editors fill them in and add the empty ones.
import type { RecordsFieldSetting } from '#records/client'

const props = withDefaults(defineProps<{
  typeKey: string
  /** The view the details open from, when it has fields of its own. */
  viewId?: string
  viewName?: string
  viewFields?: RecordsFieldSetting[]
  /** The record's values for the view's fields, as the feed carries them. */
  viewValues?: Record<string, unknown>
  /** 'edit' on the view: its fields are editable. */
  canEditView?: boolean
}>(), {
  viewId: undefined,
  viewName: undefined,
  viewFields: () => [],
  viewValues: undefined,
  canEditView: false
})

const recordId = defineModel<string | null>('recordId', { default: null })

const emit = defineEmits<{
  /** A write landed — the board behind may need to regroup. */
  changed: []
}>()

const toast = useToast()
const typePath = useRecordsTypePath()
const { isFavorite, toggle: toggleFavorite } = useViewsFavorites()
const favorite = computed(() => !!recordId.value && isFavorite('card', recordId.value))

const open = computed({
  get: () => recordId.value !== null,
  set: (v) => {
    if (!v) recordId.value = null
  }
})

function onDeleted() {
  open.value = false
  emit('changed')
}

// The view's own values: the feed's copy, replaced by each save (the new
// value at once, then the server's answer) until the next poll catches up.
const savedViewValues = ref<Record<string, unknown> | null>(null)
watch(() => [recordId.value, props.viewValues], () => {
  savedViewValues.value = null
})
const viewValues = computed(() => savedViewValues.value ?? props.viewValues ?? {})

async function commitViewField(field: RecordsFieldSetting, value: unknown) {
  if (!props.viewId || !recordId.value) return
  const before = savedViewValues.value
  savedViewValues.value = { ...viewValues.value, [field.key]: value }
  try {
    const res = await $fetch<{ viewValues: Record<string, unknown> }>(`/api/views/${props.viewId}/values/${recordId.value}`, {
      method: 'PATCH',
      body: { values: { [field.key]: value } }
    })
    savedViewValues.value = res.viewValues
    emit('changed')
  } catch (err) {
    savedViewValues.value = before
    toast.add({
      title: 'Update failed',
      description: recordsErrorMessage(err, `Failed to update ${field.label}`),
      color: 'error'
    })
  }
}

function viewUploadUrl(field: RecordsFieldSetting): string | undefined {
  return field.kind === 'attachments' && props.viewId && recordId.value
    ? `/api/views/${props.viewId}/values/${recordId.value}/attachments?field=${field.key}`
    : undefined
}
</script>

<template>
  <UModal
    v-model:open="open"
    fullscreen
    title="Details"
    description="The record's description, fields and activity."
  >
    <template #content>
      <div class="h-full overflow-y-auto p-4 sm:p-6">
        <RecordsDetailView
          v-if="recordId"
          :key="recordId"
          :type-key="typeKey"
          :record-id="recordId"
          embedded
          @changed="emit('changed')"
          @deleted="onDeleted"
          @close="open = false"
        >
          <template #actions>
            <UTooltip
              v-if="viewId"
              :text="favorite ? 'Remove from favorites' : 'Add to favorites'"
            >
              <UButton
                icon="i-lucide-star"
                variant="ghost"
                :color="favorite ? 'warning' : 'neutral'"
                size="sm"
                :aria-label="favorite ? 'Remove from favorites' : 'Add to favorites'"
                :aria-pressed="favorite"
                @click="toggleFavorite('card', recordId, viewId)"
              />
            </UTooltip>
            <UTooltip text="Open as a page">
              <UButton
                icon="i-lucide-square-arrow-out-up-right"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Open as a page"
                :to="typePath(typeKey, recordId)"
              />
            </UTooltip>
          </template>
          <template #sidebar>
            <RecordsFieldGroup
              v-if="viewFields.length > 0"
              :label="viewName ?? 'This view'"
              :fields="viewFields"
              :values="viewValues"
              :editable="canEditView"
              @commit="commitViewField"
            >
              <template #default="{ field }">
                <RecordsFieldRow
                  layout="compact"
                  :field="field"
                  :value="viewValues[field.key] ?? null"
                  :editable="canEditView"
                  :upload-url="viewUploadUrl(field)"
                  @commit="commitViewField(field, $event)"
                  @uploaded="emit('changed')"
                />
              </template>
            </RecordsFieldGroup>
          </template>
        </RecordsDetailView>
      </div>
    </template>
  </UModal>
</template>
