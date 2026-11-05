<script setup lang="ts">
// Card click target: the record's fields in a slideover, editable through
// the records kernel's own field editors and patch pipeline (useRecordsRecord), so permissions
// and validation are exactly the detail page's. Channels, connections
// widgets, comments, and the timeline stay on the full record page — the
// header links there.
import type { RecordsFieldSetting, RecordsTypeFields } from '#records/client'

const props = defineProps<{
  typeKey: string
}>()

const recordId = defineModel<string | null>('recordId', { default: null })

const emit = defineEmits<{
  /** A field commit landed — the board behind may need to regroup. */
  changed: []
}>()

const toast = useToast()
const typePath = useRecordsTypePath()
const { getFields } = useRecordsTypes()

const open = computed({
  get: () => recordId.value !== null,
  set: (v) => {
    if (!v) recordId.value = null
  }
})

const currentId = computed(() => recordId.value ?? '')
const { record, pending, error, refresh, patchFields } = useRecordsRecord(() => props.typeKey, currentId)

const fieldSettings = ref<RecordsTypeFields | null>(null)
watch(() => props.typeKey, async (key) => {
  fieldSettings.value = null
  if (!key) return
  try {
    const res = await getFields(key)
    if (key === props.typeKey) fieldSettings.value = res
  } catch {
    // Field rows just don't render; the error state below covers the record.
  }
}, { immediate: true })

watch(recordId, (id) => {
  if (id) refresh()
}, { immediate: true })

const canEdit = computed(() => record.value?.capabilities.canEdit ?? false)

// Same grouping as the detail page, minus the name (header) and channel
// fields (their widget lives on the full page only).
interface SectionGroup {
  key: string
  label: string
  fields: RecordsFieldSetting[]
}
const sectionGroups = computed<SectionGroup[]>(() => {
  const def = fieldSettings.value
  if (!def) return []
  const visible = def.fields.filter(f =>
    !f.hidden && !f.orphan && f.column !== 'name' && f.kind !== 'communication_channel')
  const known = new Set(Object.keys(def.sections))
  const groups = Object.entries(def.sections)
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
    .map(([key, section]) => ({
      key,
      label: section.label,
      fields: visible.filter(f => f.section === key)
    }))
  const rest = visible.filter(f => !f.section || !known.has(f.section))
  if (rest.length > 0) groups.push({ key: '_other', label: 'Other', fields: rest })
  return groups.filter(g => g.fields.length > 0)
})

function fieldValue(field: RecordsFieldSetting): unknown {
  return record.value?.fields[field.key] ?? null
}

async function commitField(field: RecordsFieldSetting, value: unknown) {
  try {
    await patchFields({ [field.key]: value })
    emit('changed')
  } catch (err) {
    toast.add({
      title: 'Update failed',
      description: recordsErrorMessage(err, `Failed to update ${field.label}`),
      color: 'error'
    })
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    :ui="{ content: 'max-w-md' }"
  >
    <template #content>
      <div class="flex flex-col h-full">
        <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border)">
          <h2 class="flex-1 text-base font-semibold truncate">
            {{ record?.name ?? '…' }}
          </h2>
          <UButton
            v-if="recordId"
            icon="i-lucide-maximize-2"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Open full record"
            :to="typePath(typeKey, recordId)"
          />
          <UButton
            icon="i-lucide-x"
            variant="ghost"
            color="neutral"
            size="sm"
            aria-label="Close"
            @click="open = false"
          />
        </header>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <UAlert
            v-if="error"
            color="error"
            :title="error"
          />
          <template v-else-if="record">
            <RecordsFieldSection
              v-for="group in sectionGroups"
              :key="group.key"
              :label="group.label"
            >
              <RecordsFieldRow
                v-for="field in group.fields"
                :key="field.key"
                :field="field"
                :value="fieldValue(field)"
                :editable="canEdit"
                @commit="commitField(field, $event)"
              />
            </RecordsFieldSection>
          </template>
          <div
            v-else-if="pending"
            class="grid place-items-center py-12"
          >
            <UIcon
              name="i-lucide-loader-circle"
              class="size-6 animate-spin text-(--ui-text-muted)"
            />
          </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>
