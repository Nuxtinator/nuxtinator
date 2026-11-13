<script setup lang="ts">
// Create-view modal. It opens on "What are you tracking?": To-dos (a task
// board by status), an ideas board (items in their own columns), a list of
// anything (items), or one of the org's record types the caller can create.
// A starter sets the record type, what the view holds and the first tab's
// layout; the name and who can see it follow, with everything else under
// "More options": the record type, what the view holds — its own cards (it
// starts empty and holds only records added or created on it) or every
// matching record of the type — and the layout: a board, a list or a table.
// A board groups by a field (columns = its values) or has its own columns. A
// list may group into sections by a field. What the view holds can't change
// later. On success it navigates straight to the new view. `audience` sets
// who it starts open to: 'mine' starts private; 'teams' starts on the
// caller's team (they pick when they have several), or Everyone when they
// have none.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsLayout, ViewsVisibility } from '../../utils/views-types'

const props = withDefaults(defineProps<{
  audience?: 'mine' | 'teams'
}>(), {
  audience: 'mine'
})

const open = defineModel<boolean>('open', { default: false })

const viewsPath = useViewsPath()
const { visibleTypes, ensureTypes, getFields } = useRecordsTypes()
const { create } = useViewsList()
const { mode: teamsMode, teams, pending: teamsPending } = useTeams('views')

// Fresh boards start with the classic three lanes; edit-level users reshape
// them later from the board itself.
const DEFAULT_COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'Doing' },
  { key: 'done', label: 'Done' }
]

interface ViewsStarter {
  id: string
  label: string
  icon: string
  typeKey: string
  /** What the view holds; absent = every matching record when the caller sees all of the type. */
  kind?: 'picked' | 'matching'
  layout: ViewsLayout
  kanbanMode?: 'field' | 'custom'
  placeholder: string
}

const starters = computed<ViewsStarter[]>(() => {
  const creatable = visibleTypes.value.filter(t => t.canCreate)
  const has = (key: string) => creatable.some(t => t.key === key)
  const out: ViewsStarter[] = []
  if (has('task')) {
    out.push({ id: 'todos', label: 'To-dos', icon: 'i-lucide-square-check', typeKey: 'task', kind: 'picked', layout: 'kanban', kanbanMode: 'field', placeholder: 'My to-dos' })
  }
  if (has('item')) {
    out.push({ id: 'ideas', label: 'Ideas board', icon: 'i-lucide-lightbulb', typeKey: 'item', kind: 'picked', layout: 'kanban', kanbanMode: 'custom', placeholder: 'Ideas for the project' })
    out.push({ id: 'list', label: 'A list of anything', icon: 'i-lucide-list', typeKey: 'item', kind: 'picked', layout: 'list', placeholder: 'Ways to bake a pizza' })
  }
  for (const t of creatable) {
    if (t.key === 'task' || t.key === 'item') continue
    out.push({ id: `type:${t.key}`, label: t.label, icon: t.icon ?? 'i-lucide-database', typeKey: t.key, layout: 'kanban', kanbanMode: 'field', placeholder: t.label })
  }
  return out
})

const starter = ref<ViewsStarter | null>(null)
const moreOpen = ref(false)

function pickStarter(choice: ViewsStarter) {
  starter.value = choice
  viewType.value = choice.layout
  kanbanMode.value = choice.kanbanMode ?? 'field'
  typeKey.value = choice.typeKey
  if (choice.kind) kind.value = choice.kind
}

function pickAnything() {
  starter.value = { id: 'custom', label: 'Something else', icon: 'i-lucide-settings-2', typeKey: '', layout: 'kanban', placeholder: '' }
  moreOpen.value = true
}

const name = ref('')
const icon = ref<string | null>(null)
const typeKey = ref<string | undefined>(undefined)
const kind = ref<'picked' | 'matching'>('picked')
const viewType = ref<ViewsLayout>('kanban')
const kanbanMode = ref<'field' | 'custom'>('field')
const groupField = ref<string | undefined>(undefined)
const visibility = ref<string>('private')
const teamIds = ref<string[]>([])
const orgLevel = ref<'view' | 'edit'>('view')
const teamLevels = ref<Record<string, 'view' | 'edit'>>({})
const creating = ref(false)
const createError = ref<string | null>(null)
const audienceApplied = ref(false)

const fields = ref<RecordsFieldSetting[]>([])
const fieldsPending = ref(false)

watch(open, (v) => {
  if (!v) return
  name.value = ''
  starter.value = null
  moreOpen.value = false
  icon.value = null
  typeKey.value = undefined
  kind.value = 'picked'
  viewType.value = 'kanban'
  kanbanMode.value = 'field'
  groupField.value = undefined
  visibility.value = 'private'
  teamIds.value = []
  orgLevel.value = 'view'
  teamLevels.value = {}
  createError.value = null
  audienceApplied.value = false
  ensureTypes().catch(() => {
    // The type select stays empty; submit stays disabled.
  })
})

// Runs once per opening, after the caller's teams have loaded.
watch([open, teamsPending], () => {
  if (!open.value || audienceApplied.value || teamsPending.value) return
  audienceApplied.value = true
  if (props.audience !== 'teams') return
  const myTeams = teams.value.filter(t => t.mine && !t.archived)
  if (teamsMode.value === 'teams' && myTeams.length > 0) {
    visibility.value = 'teams'
    teamIds.value = myTeams.length === 1 ? [myTeams[0]!.id] : []
  } else {
    visibility.value = 'org'
  }
}, { immediate: true })

watch(typeKey, async (key) => {
  groupField.value = undefined
  fields.value = []
  if (!key) return
  kind.value = starter.value?.kind ?? (visibleTypes.value.find(t => t.key === key)?.canViewAll ? 'matching' : 'picked')
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

const typeLabel = computed(() => visibleTypes.value.find(t => t.key === typeKey.value)?.label ?? 'records')
const KIND_ITEMS = computed(() => [
  { value: 'picked' as const, label: 'Its own cards', icon: 'i-lucide-square-plus' },
  { value: 'matching' as const, label: `All ${typeLabel.value.toLowerCase()}`, icon: 'i-lucide-layers' }
])

const VIEW_TYPE_ITEMS = (['kanban', 'list', 'table'] as const).map(value => ({ value, ...VIEWS_LAYOUT_META[value] }))
const KANBAN_MODE_ITEMS = [
  { value: 'field' as const, label: 'Group by a field', icon: 'i-lucide-tag' },
  { value: 'custom' as const, label: 'Custom columns', icon: 'i-lucide-columns-3' }
]

const canSubmit = computed(() => {
  if (!name.value.trim() || !typeKey.value) return false
  if (visibility.value === 'teams' && teamIds.value.length === 0) return false
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
    if (kind.value === 'picked') definition.picked = true
    if (viewType.value === 'kanban') {
      if (kanbanMode.value === 'field') {
        tabDefinition.groupField = groupField.value
      } else {
        tabDefinition.columns = kind.value === 'picked' ? DEFAULT_COLUMNS : []
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
      teamLevels: visibility.value === 'teams' ? teamLevels.value : undefined,
      orgLevel: visibility.value === 'org' ? orgLevel.value : undefined,
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
      <div
        v-if="!starter"
        class="space-y-3"
      >
        <p class="text-sm font-medium">
          What are you tracking?
        </p>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="choice in starters"
            :key="choice.id"
            type="button"
            class="flex items-center gap-3 rounded-lg border border-(--ui-border) px-3 py-3 text-left bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated) dark:border-(--ui-border-accented)"
            @click="pickStarter(choice)"
          >
            <UIcon
              :name="choice.icon"
              class="size-5 shrink-0 text-(--ui-text-muted)"
            />
            <span class="text-sm font-medium">{{ choice.label }}</span>
          </button>
          <button
            type="button"
            class="flex items-center gap-3 rounded-lg border border-dashed border-(--ui-border) px-3 py-3 text-left hover:bg-(--ui-bg-elevated)/50"
            @click="pickAnything"
          >
            <UIcon
              name="i-lucide-settings-2"
              class="size-5 shrink-0 text-(--ui-text-muted)"
            />
            <span class="text-sm font-medium">Something else</span>
          </button>
        </div>
      </div>

      <form
        v-else
        id="views-create-form"
        class="space-y-5"
        @submit.prevent="submit"
      >
        <UButton
          icon="i-lucide-arrow-left"
          variant="link"
          color="neutral"
          size="sm"
          class="px-0"
          :disabled="creating"
          @click="starter = null"
        >
          {{ starter.label }}
        </UButton>

        <UFormField
          label="Name"
          required
        >
          <div class="flex gap-2">
            <IconPicker
              v-model="icon"
              :disabled="creating"
            />
            <UInput
              v-model="name"
              autofocus
              class="flex-1"
              :placeholder="starter.placeholder"
              :disabled="creating"
            />
          </div>
        </UFormField>

        <UButton
          v-if="!moreOpen"
          icon="i-lucide-chevron-right"
          variant="link"
          color="neutral"
          size="sm"
          class="px-0"
          @click="moreOpen = true"
        >
          More options
        </UButton>

        <template v-if="moreOpen">
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

          <UFormField
            v-if="typeKey"
            label="Holds"
          >
            <ViewsChoiceCards
              v-model="kind"
              :items="KIND_ITEMS"
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
        </template>

        <USeparator />

        <TeamAccessField
          v-model:visibility="visibility"
          v-model:team-ids="teamIds"
          v-model:org-level="orgLevel"
          v-model:team-levels="teamLevels"
          app-id="views"
          none-value="private"
          levels
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
          v-if="starter"
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
