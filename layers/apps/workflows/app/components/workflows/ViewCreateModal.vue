<script setup lang="ts">
// Create-view modal: name, record type, kanban/table, and — for kanbans —
// the grouping choice: a groupable field (columns = its options) or custom
// columns owned by the view (a Trello-style board, cards added explicitly).
// On success it navigates straight to the new view.
import type { CrmFieldSetting } from '../../../../crm/app/utils/field-kinds'
import type { WorkflowsViewType, WorkflowsVisibility } from '../../utils/workflows-types'

const open = defineModel<boolean>('open', { default: false })

const workflowsPath = useWorkflowsPath()
const { visibleTypes, ensureTypes, getFields } = useCrmTypes()
const { create } = useWorkflowsViews()

// Fresh boards start with the classic three lanes; edit-level users reshape
// them later from the board itself.
const DEFAULT_COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

const name = ref('')
const typeKey = ref<string | undefined>(undefined)
const viewType = ref<WorkflowsViewType>('kanban')
const kanbanMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)
const visibility = ref<WorkflowsVisibility>('private')
const creating = ref(false)
const createError = ref<string | null>(null)

const fields = ref<CrmFieldSetting[]>([])
const fieldsPending = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  typeKey.value = undefined
  viewType.value = 'kanban'
  kanbanMode.value = 'field'
  groupField.value = undefined
  visibility.value = 'private'
  createError.value = null
  ensureTypes().catch(() => {
    // The type select stays empty; submit stays disabled.
  })
})

watch(typeKey, async (key) => {
  groupField.value = undefined
  fields.value = []
  if (!key) return
  fieldsPending.value = true
  try {
    const res = await getFields(key)
    if (key === typeKey.value) fields.value = res.fields
  } catch {
    // No groupable fields — the field-mode select stays empty; custom
    // columns remain available.
  } finally {
    fieldsPending.value = false
  }
})

const typeItems = computed(() =>
  visibleTypes.value.map(t => ({ label: t.label, value: t.key })))

const groupFieldItems = computed(() =>
  workflowsGroupableFields(fields.value).map(f => ({ label: f.label, value: f.key })))

const VIEW_TYPE_ITEMS = [
  { label: 'Kanban board', value: 'kanban' },
  { label: 'Table', value: 'table' }
]
const KANBAN_MODE_ITEMS = [
  { label: 'Group by a field', value: 'field' },
  { label: 'Custom columns', value: 'custom' }
]
const VISIBILITY_ITEMS = [
  { label: 'Private — only me', value: 'private' },
  { label: 'Shared — people I invite', value: 'shared' },
  { label: 'Organization — everyone', value: 'org' }
]

const canSubmit = computed(() => {
  if (!name.value.trim() || !typeKey.value) return false
  if (viewType.value === 'kanban' && kanbanMode.value === 'field' && !groupField.value) return false
  return true
})

async function submit() {
  if (!canSubmit.value || creating.value) return
  creating.value = true
  createError.value = null
  try {
    const definition: Record<string, unknown> = {}
    if (viewType.value === 'kanban') {
      if (kanbanMode.value === 'field') definition.groupField = groupField.value
      else definition.columns = DEFAULT_COLUMNS
    }
    const created = await create({
      name: name.value.trim(),
      recordTypeKey: typeKey.value!,
      viewType: viewType.value,
      visibility: visibility.value,
      definition
    })
    open.value = false
    await navigateTo(workflowsPath(`/${created.id}`))
  } catch (err) {
    createError.value = crmErrorMessage(err, 'Failed to create the view')
  } finally {
    creating.value = false
  }
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
          New view
        </h2>

        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="name"
            autofocus
            class="w-full"
            :disabled="creating"
          />
        </UFormField>

        <UFormField
          label="Record type"
          required
        >
          <USelectMenu
            v-model="typeKey"
            :items="typeItems"
            value-key="value"
            label-key="label"
            placeholder="Select a record type..."
            class="w-full"
            :disabled="creating"
          />
        </UFormField>

        <UFormField label="View type">
          <URadioGroup
            v-model="viewType"
            :items="VIEW_TYPE_ITEMS"
            orientation="horizontal"
            :disabled="creating"
          />
        </UFormField>

        <template v-if="viewType === 'kanban'">
          <UFormField label="Columns">
            <URadioGroup
              v-model="kanbanMode"
              :items="KANBAN_MODE_ITEMS"
              orientation="horizontal"
              :disabled="creating"
            />
          </UFormField>

          <UFormField
            v-if="kanbanMode === 'field'"
            label="Group by"
            required
          >
            <USelectMenu
              v-model="groupField"
              :items="groupFieldItems"
              value-key="value"
              label-key="label"
              :placeholder="fieldsPending ? 'Loading fields...' : 'Select a field...'"
              class="w-full"
              :disabled="creating || !typeKey"
            />
            <template
              v-if="typeKey && !fieldsPending && groupFieldItems.length === 0"
              #help
            >
              This type has no groupable field — use custom columns instead.
            </template>
          </UFormField>

          <p
            v-else
            class="text-xs text-(--ui-text-muted)"
          >
            Starts with To do / Doing / Done. You add cards to the board and
            shape its columns afterwards.
          </p>
        </template>

        <UFormField label="Visibility">
          <USelectMenu
            v-model="visibility"
            :items="VISIBILITY_ITEMS"
            value-key="value"
            label-key="label"
            class="w-full"
            :disabled="creating"
          />
        </UFormField>

        <UAlert
          v-if="createError"
          color="error"
          :title="createError"
        />

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            :disabled="creating"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            :loading="creating"
            :disabled="!canSubmit"
          >
            Create
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
