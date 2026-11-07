<script setup lang="ts">
// Add or change a tab: its name, layout, and how it groups. A board groups by
// a field or has its own columns; a list may group into sections; a table
// doesn't group.
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
}

const emit = defineEmits<{
  save: [choice: ViewsTabChoice]
}>()

const name = ref('')
const layout = ref<ViewsLayout>('kanban')
const boardMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)

watch(open, (v) => {
  if (!v) return
  const tab = props.tab
  name.value = tab?.name ?? ''
  layout.value = tab?.layout ?? 'kanban'
  boardMode.value = tab?.definition.columns ? 'custom' : 'field'
  groupField.value = tab?.definition.groupField
})

const LAYOUT_ITEMS = (['kanban', 'list', 'table'] as const).map(value => ({ value, ...VIEWS_LAYOUT_META[value] }))
const BOARD_MODE_ITEMS = [
  { value: 'field' as const, label: 'Group by a field', icon: 'i-lucide-tag' },
  { value: 'custom' as const, label: 'Custom columns', icon: 'i-lucide-columns-3' }
]

const groupFieldItems = computed(() =>
  viewsGroupableFields(props.fields).map(f => ({ label: f.label, value: f.key })))

const ownColumns = computed(() => layout.value === 'kanban' && boardMode.value === 'custom')

const canSave = computed(() => {
  if (layout.value === 'kanban' && !ownColumns.value && !groupField.value) return false
  return true
})

function submit() {
  if (!canSave.value || props.saving) return
  emit('save', {
    name: name.value.trim() || VIEWS_LAYOUT_META[layout.value].label,
    layout: layout.value,
    groupField: layout.value === 'table' || ownColumns.value ? null : groupField.value ?? null,
    ownColumns: ownColumns.value
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
