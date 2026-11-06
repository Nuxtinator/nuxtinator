<script setup lang="ts">
// Create-view modal: name, record type, and the first tab's layout — a
// board, a list or a table. A board groups by a field (columns = its values)
// or has its own columns (a Trello-style board; the view then holds only
// records added to it). A list may group into sections by a field. On success
// it navigates straight to the new view.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsLayout, ViewsVisibility } from '../../utils/views-types'

const open = defineModel<boolean>('open', { default: false })

const viewsPath = useViewsPath()
const { visibleTypes, ensureTypes, getFields } = useRecordsTypes()
const { create } = useViewsList()

// Fresh boards start with the classic three lanes; edit-level users reshape
// them later from the board itself.
const DEFAULT_COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

const name = ref('')
const icon = ref<string | null>(null)
const typeKey = ref<string | undefined>(undefined)
const viewType = ref<ViewsLayout>('kanban')
const kanbanMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)
const visibility = ref<string>('private')
const teamIds = ref<string[]>([])
const creating = ref(false)
const createError = ref<string | null>(null)

const fields = ref<RecordsFieldSetting[]>([])
const fieldsPending = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  icon.value = null
  typeKey.value = undefined
  viewType.value = 'kanban'
  kanbanMode.value = 'field'
  groupField.value = undefined
  visibility.value = 'private'
  teamIds.value = []
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
    if (key === typeKey.value) {
      fields.value = res.fields
      if (viewType.value === 'kanban') groupField.value = statusGroupKey()
    }
  } catch {
    // No groupable fields — the field-mode select stays empty; custom
    // columns remain available.
  } finally {
    fieldsPending.value = false
  }
})

const typeItems = computed(() =>
  visibleTypes.value.map(t => ({ label: t.label, value: t.key, icon: t.icon ?? undefined })))
const typeIcon = computed(() => typeItems.value.find(t => t.value === typeKey.value)?.icon)

const groupFieldItems = computed(() =>
  viewsGroupableFields(fields.value).map(f => ({ label: f.label, value: f.key })))

// Boards start grouped by status; lists start ungrouped.
function statusGroupKey(): string | undefined {
  return viewsGroupableFields(fields.value).find(f => f.column === 'status')?.key
}

watch(viewType, (type) => {
  if (type === 'kanban' && !groupField.value) groupField.value = statusGroupKey()
  else if (type !== 'kanban' && groupField.value === statusGroupKey()) groupField.value = undefined
})

const VIEW_TYPE_ITEMS = (['kanban', 'list', 'table'] as const).map(value => ({ value, ...VIEWS_LAYOUT_META[value] }))
const KANBAN_MODE_ITEMS = [
  { value: 'field' as const, label: 'Group by a field', icon: 'i-lucide-tag' },
  { value: 'custom' as const, label: 'Custom columns', icon: 'i-lucide-columns-3' }
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
    const tabDefinition: Record<string, unknown> = {}
    const definition: Record<string, unknown> = {}
    if (viewType.value === 'kanban') {
      if (kanbanMode.value === 'field') {
        tabDefinition.groupField = groupField.value
      } else {
        tabDefinition.columns = DEFAULT_COLUMNS
        definition.picked = true
      }
    } else if (viewType.value === 'list' && groupField.value) {
      tabDefinition.groupField = groupField.value
    }
    const created = await create({
      name: name.value.trim(),
      icon: icon.value ?? undefined,
      recordTypeKey: typeKey.value!,
      visibility: visibility.value as ViewsVisibility,
      teamIds: visibility.value === 'teams' ? teamIds.value : undefined,
      definition,
      tab: { layout: viewType.value, definition: tabDefinition }
    })
    open.value = false
    await navigateTo(viewsPath(`/${created.id}`))
  } catch (err) {
    createError.value = recordsErrorMessage(err, 'Failed to create the view')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New view"
    :dismissible="!creating"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <form
        id="views-create-form"
        class="space-y-5"
        @submit.prevent="submit"
      >
        <UFormField
          label="Name"
          required
        >
          <div class="flex gap-2">
            <UInput
              v-model="name"
              autofocus
              class="flex-1"
              :disabled="creating"
            />
            <div class="w-36 shrink-0">
              <IconPicker
                v-model="icon"
                placeholder="Icon…"
                :disabled="creating"
              />
            </div>
          </div>
        </UFormField>

        <UFormField
          label="Record type"
          required
        >
          <USelectMenu
            v-model="typeKey"
            :items="typeItems"
            :icon="typeIcon"
            value-key="value"
            label-key="label"
            placeholder="Select a record type..."
            class="w-full"
            :disabled="creating"
          />
        </UFormField>

        <UFormField label="Layout">
          <ViewsChoiceCards
            v-model="viewType"
            :items="VIEW_TYPE_ITEMS"
            :disabled="creating"
          />
        </UFormField>

        <template v-if="viewType === 'kanban'">
          <UFormField label="Columns">
            <ViewsChoiceCards
              v-model="kanbanMode"
              :items="KANBAN_MODE_ITEMS"
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
        </template>

        <UFormField
          v-else-if="viewType === 'list'"
          label="Sections"
        >
          <div class="flex gap-2">
            <USelectMenu
              v-model="groupField"
              :items="groupFieldItems"
              value-key="value"
              label-key="label"
              :placeholder="fieldsPending ? 'Loading fields...' : 'No sections'"
              class="flex-1"
              :disabled="creating || !typeKey"
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

        <USeparator />

        <TeamAccessField
          v-model:visibility="visibility"
          v-model:team-ids="teamIds"
          app-id="views"
          none-value="private"
          :disabled="creating"
        />

        <UAlert
          v-if="createError"
          color="error"
          :title="createError"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex gap-2 justify-end w-full">
        <UButton
          variant="ghost"
          color="neutral"
          :disabled="creating"
          @click="open = false"
        >
          Cancel
        </UButton>
        <UButton
          type="submit"
          form="views-create-form"
          :loading="creating"
          :disabled="!canSubmit"
        >
          Create view
        </UButton>
      </div>
    </template>
  </UModal>
</template>
