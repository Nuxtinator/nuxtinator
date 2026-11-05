<script setup lang="ts">
// Add or change a tab: its name, layout, and how it groups. A board groups by
// a field or — in a view of hand-picked records — has its own columns; a list
// may group into sections; a table doesn't group.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsLayout, ViewsTab } from '../../utils/views-types'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  /** The tab being changed; null adds a new one. */
  tab: ViewsTab | null
  fields: RecordsFieldSetting[]
  /** The view holds hand-picked records, so boards may have their own columns. */
  picked: boolean
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
const layout = ref<ViewsLayout>('list')
const boardMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)

watch(open, (v) => {
  if (!v) return
  const tab = props.tab
  name.value = tab?.name ?? ''
  layout.value = tab?.layout ?? 'list'
  boardMode.value = tab?.definition.columns ? 'custom' : 'field'
  groupField.value = tab?.definition.groupField
})

const LAYOUT_ITEMS = [
  { label: 'List', value: 'list' },
  { label: 'Board', value: 'kanban' },
  { label: 'Table', value: 'table' }
]
const BOARD_MODE_ITEMS = [
  { label: 'Group by a field', value: 'field' },
  { label: 'Own columns', value: 'custom' }
]

const groupFieldItems = computed(() =>
  viewsGroupableFields(props.fields).map(f => ({ label: f.label, value: f.key })))

const ownColumns = computed(() => layout.value === 'kanban' && props.picked && boardMode.value === 'custom')

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
  <UModal v-model:open="open">
    <template #content>
      <form
        class="p-6 space-y-4"
        @submit.prevent="submit"
      >
        <h2 class="text-lg font-semibold">
          {{ tab ? 'Tab settings' : 'New tab' }}
        </h2>

        <UFormField label="Name">
          <UInput
            v-model="name"
            autofocus
            :placeholder="VIEWS_LAYOUT_META[layout].label"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Layout">
          <URadioGroup
            v-model="layout"
            :items="LAYOUT_ITEMS"
            orientation="horizontal"
          />
        </UFormField>

        <template v-if="layout === 'kanban'">
          <UFormField
            v-if="picked"
            label="Columns"
          >
            <URadioGroup
              v-model="boardMode"
              :items="BOARD_MODE_ITEMS"
              orientation="horizontal"
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

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="saving"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :loading="saving"
            :disabled="!canSave"
          >
            {{ tab ? 'Save' : 'Add tab' }}
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
