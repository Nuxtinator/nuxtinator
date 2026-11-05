<script setup lang="ts">
// Picks which record values a view shows and in what order — the fields on
// kanban cards, the columns of a table. The record name is always shown, so
// it isn't offered. A saved key whose field has since disappeared still
// lists (by its raw key) so it can be removed. A view starts from its record
// type's default layout; saving here gives it its own, and resetting returns
// it to the type's. Connection fields choose how they show: names, a count,
// or done-progress.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsTabView, ViewsCardLayout, ViewsConnectionDisplay } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  fields: RecordsFieldSetting[]
  /** The layout the view renders now (its own, or its type's default). */
  layout: ViewsCardLayout
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  /** null resets the view to its type's default layout. */
  save: [layout: { cardFields: string[], cardConnections: Record<string, ViewsConnectionDisplay> } | null]
}>()

const selected = ref<string[]>([])
const displays = ref<Record<string, ViewsConnectionDisplay>>({})

const DISPLAY_ITEMS: Array<{ label: string, value: ViewsConnectionDisplay }> = [
  { label: 'Names', value: 'names' },
  { label: 'Count', value: 'count' },
  { label: 'Progress', value: 'progress' }
]

const fieldByKey = computed(() => new Map(props.fields.map(f => [f.key, f])))
const isConnection = (key: string) => fieldByKey.value.get(key)?.kind === 'connection'

function displayOf(key: string): ViewsConnectionDisplay {
  return displays.value[key] ?? 'names'
}

function setDisplay(key: string, value: ViewsConnectionDisplay) {
  displays.value = { ...displays.value, [key]: value }
}

const choices = computed(() => viewsCardFieldChoices(props.fields))

const isTable = computed(() => props.view.viewType === 'table')

function labelOf(key: string): string {
  return choices.value.find(c => c.key === key)?.label ?? key
}

watch(open, (v) => {
  if (!v) return
  selected.value = [...props.layout.fields]
  displays.value = { ...props.layout.connections }
})

const available = computed(() =>
  choices.value.filter(c => !selected.value.includes(c.key)))

function add(key: string) {
  selected.value = [...selected.value, key]
}

function remove(key: string) {
  selected.value = selected.value.filter(k => k !== key)
}

function moveBy(index: number, delta: number) {
  const next = [...selected.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item!)
  selected.value = next
}

function submit() {
  const cardConnections = Object.fromEntries(
    Object.entries(displays.value).filter(([key, d]) => selected.value.includes(key) && isConnection(key) && d !== 'names'))
  emit('save', { cardFields: [...selected.value], cardConnections })
  open.value = false
}

function resetToDefault() {
  emit('save', null)
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <form
        class="p-6 space-y-4"
        @submit.prevent="submit"
      >
        <div>
          <h2 class="text-lg font-semibold">
            {{ isTable ? 'Table columns' : view.viewType === 'list' ? 'Row fields' : 'Card fields' }}
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            {{ isTable
              ? 'Columns shown after the name, in this order.'
              : view.viewType === 'list'
                ? 'Values shown on each row, in this order.'
                : 'Values shown on each card, in this order.' }}
          </p>
        </div>

        <UAlert
          v-if="layout.custom"
          color="neutral"
          variant="subtle"
          icon="i-lucide-pencil-ruler"
          title="This view has its own layout."
          description="Changes to the record type's default layout don't apply here."
        >
          <template #actions>
            <UButton
              size="xs"
              variant="outline"
              color="neutral"
              @click="resetToDefault"
            >
              Use the type's default
            </UButton>
          </template>
        </UAlert>
        <p
          v-else
          class="text-xs text-(--ui-text-muted)"
        >
          Showing the record type's default layout. Saving gives this view its own.
        </p>

        <ul
          v-if="selected.length > 0"
          class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border)"
        >
          <li
            v-for="(key, index) in selected"
            :key="key"
            class="flex items-center gap-1 px-3 py-1.5"
          >
            <span class="flex-1 text-sm truncate">{{ labelOf(key) }}</span>
            <USelect
              v-if="isConnection(key)"
              :model-value="displayOf(key)"
              :items="DISPLAY_ITEMS"
              size="xs"
              class="w-28"
              :aria-label="`How ${labelOf(key)} shows`"
              @update:model-value="setDisplay(key, $event as ViewsConnectionDisplay)"
            />
            <UButton
              icon="i-lucide-chevron-up"
              variant="ghost"
              color="neutral"
              size="xs"
              :disabled="index === 0"
              :aria-label="`Move ${labelOf(key)} up`"
              @click="moveBy(index, -1)"
            />
            <UButton
              icon="i-lucide-chevron-down"
              variant="ghost"
              color="neutral"
              size="xs"
              :disabled="index === selected.length - 1"
              :aria-label="`Move ${labelOf(key)} down`"
              @click="moveBy(index, 1)"
            />
            <UButton
              icon="i-lucide-x"
              variant="ghost"
              color="neutral"
              size="xs"
              :aria-label="`Remove ${labelOf(key)}`"
              @click="remove(key)"
            />
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-(--ui-text-muted) rounded-lg border border-dashed border-(--ui-border) px-3 py-4 text-center"
        >
          Only the name will be shown.
        </p>

        <div
          v-if="available.length > 0"
          class="space-y-1"
        >
          <p class="text-xs font-medium text-(--ui-text-muted)">
            Add a field
          </p>
          <div class="flex flex-wrap gap-1">
            <UButton
              v-for="choice in available"
              :key="choice.key"
              icon="i-lucide-plus"
              variant="outline"
              color="neutral"
              size="xs"
              @click="add(choice.key)"
            >
              {{ choice.label }}
            </UButton>
          </div>
        </div>

        <div class="flex gap-2 justify-end">
          <UButton
            variant="ghost"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton type="submit">
            Save
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
