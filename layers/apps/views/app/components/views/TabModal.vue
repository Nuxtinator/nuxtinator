<script setup lang="ts">
// Add or change a tab: its name, layout, and how it groups. A board groups by
// a field or has its own columns; a list may group into sections; a table
// doesn't group; a calendar places records by a date field, optionally
// spanning to an end date.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsLayout, ViewsTab } from '../../utils/views-types'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  /** The tab being changed; null adds a new one. */
  tab: ViewsTab | null
  fields: RecordsFieldSetting[]
  saving?: boolean
}>()

export interface ViewsTabChoice {
  name: string
  layout: ViewsLayout
  groupField: string | null
  ownColumns: boolean
  dateField: string | null
  endField: string | null
}

const emit = defineEmits<{
  save: [choice: ViewsTabChoice]
}>()

const name = ref('')
const layout = ref<ViewsLayout>('kanban')
const boardMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)
const dateField = ref<string | undefined>(undefined)
const endField = ref<string | undefined>(undefined)

watch(open, (v) => {
  if (!v) return
  const tab = props.tab
  name.value = tab?.name ?? ''
  layout.value = tab?.layout ?? 'kanban'
  boardMode.value = tab?.definition.columns ? 'custom' : 'field'
  groupField.value = tab?.definition.groupField
  dateField.value = tab?.definition.dateField
  endField.value = tab?.definition.endField
})

const LAYOUT_ITEMS = VIEWS_LAYOUT_ORDER.map(value => ({ value, ...VIEWS_LAYOUT_META[value] }))
const BOARD_MODE_ITEMS = [
  { value: 'field' as const, label: 'Group by a field', icon: 'i-lucide-tag' },
  { value: 'custom' as const, label: 'Custom columns', icon: 'i-lucide-columns-3' }
]

const groupFieldItems = computed(() =>
  viewsGroupableFields(props.fields).map(f => ({ label: f.label, value: f.key })))

const dateFieldItems = computed(() =>
  viewsDateFields(props.fields).map(f => ({ label: f.label, value: f.key })))
const endFieldItems = computed(() => dateFieldItems.value.filter(f => f.value !== dateField.value))

// A calendar starts on the first date field the record type has.
watch(layout, (next) => {
  if (next === 'calendar' && !dateField.value) dateField.value = dateFieldItems.value[0]?.value
})
watch(dateField, (next) => {
  if (next && next === endField.value) endField.value = undefined
})

const ownColumns = computed(() => layout.value === 'kanban' && boardMode.value === 'custom')

const canSave = computed(() => {
  if (layout.value === 'kanban' && !ownColumns.value && !groupField.value) return false
  if (layout.value === 'calendar' && !dateField.value) return false
  return true
})

function submit() {
  if (!canSave.value || props.saving) return
  emit('save', {
    name: name.value.trim() || VIEWS_LAYOUT_META[layout.value].label,
    layout: layout.value,
    groupField: layout.value === 'table' || layout.value === 'calendar' || ownColumns.value ? null : groupField.value ?? null,
    ownColumns: ownColumns.value,
    dateField: layout.value === 'calendar' ? dateField.value ?? null : null,
    endField: layout.value === 'calendar' ? endField.value ?? null : null
  })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="tab ? 'Tab settings' : 'New tab'"
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <form
        id="views-tab-form"
        class="space-y-5"
        @submit.prevent="submit"
      >
        <UFormField label="Name">
          <UInput
            v-model="name"
            autofocus
            :placeholder="VIEWS_LAYOUT_META[layout].label"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Layout">
          <ViewsChoiceCards
            v-model="layout"
            :items="LAYOUT_ITEMS"
          />
        </UFormField>

        <template v-if="layout === 'kanban'">
          <UFormField>
            <template #label>
              Columns
              <InfoTip text="Moving a card between custom columns only changes where it sits on this board, never the record." />
            </template>
            <ViewsChoiceCards
              v-model="boardMode"
              :items="BOARD_MODE_ITEMS"
            />
          </UFormField>
          <UFormField
            v-if="!ownColumns"
            label="Group by"
            required
          >
            <USelectMenu
              v-model="groupField"
              :items="groupFieldItems"
              value-key="value"
              label-key="label"
              placeholder="Select a field..."
              class="w-full"
            />
          </UFormField>
        </template>

        <UFormField
          v-else-if="layout === 'list'"
          label="Sections"
        >
          <div class="flex gap-2">
            <USelectMenu
              v-model="groupField"
              :items="groupFieldItems"
              value-key="value"
              label-key="label"
              placeholder="No sections"
              class="flex-1"
            />
            <UButton
              v-if="groupField"
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              aria-label="No sections"
              @click="groupField = undefined"
            />
          </div>
        </UFormField>

        <template v-else-if="layout === 'calendar'">
          <UFormField
            label="Date"
            required
          >
            <USelectMenu
              v-model="dateField"
              :items="dateFieldItems"
              value-key="value"
              label-key="label"
              placeholder="Select a date field..."
              class="w-full"
            />
          </UFormField>
          <UFormField>
            <template #label>
              End date
              <InfoTip text="With an end date, each record spans every day from its date to its end date." />
            </template>
            <div class="flex gap-2">
              <USelectMenu
                v-model="endField"
                :items="endFieldItems"
                value-key="value"
                label-key="label"
                placeholder="None"
                class="flex-1"
              />
              <UButton
                v-if="endField"
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                aria-label="No end date"
                @click="endField = undefined"
              />
            </div>
          </UFormField>
        </template>
      </form>
    </template>

    <template #footer>
      <div class="flex gap-2 justify-end w-full">
        <UButton
          variant="ghost"
          color="neutral"
          :disabled="saving"
          @click="open = false"
        >
          Cancel
        </UButton>
        <UButton
          type="submit"
          form="views-tab-form"
          :loading="saving"
          :disabled="!canSave"
        >
          {{ tab ? 'Save' : 'Add tab' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
