<script setup lang="ts">
// Picks which record values a view shows and in what order — the fields on
// kanban cards, the columns of a table. The record name is always shown, so
// it isn't offered. A saved key whose field has since disappeared still
// lists (by its raw key) so it can be removed.
import type { CrmFieldSetting } from '../../../../crm/app/utils/field-kinds'
import type { WorkflowsViewDetail } from '../../utils/workflows-types'

const props = defineProps<{
  view: WorkflowsViewDetail
  fields: CrmFieldSetting[]
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  save: [cardFields: string[]]
}>()

const selected = ref<string[]>([])

const choices = computed(() => workflowsCardFieldChoices(props.fields))

const isTable = computed(() => props.view.viewType === 'table')

function labelOf(key: string): string {
  return choices.value.find(c => c.key === key)?.label ?? key
}

watch(open, (v) => {
  if (!v) return
  selected.value = [...(props.view.definition.cardFields
    ?? WORKFLOWS_DEFAULT_CARD_FIELDS[props.view.viewType])]
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
  emit('save', [...selected.value])
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
            {{ isTable ? 'Table columns' : 'Card fields' }}
          </h2>
          <p class="text-sm text-(--ui-text-muted)">
            {{ isTable
              ? 'Columns shown after the name, in this order.'
              : 'Values shown on each card, in this order.' }}
          </p>
        </div>

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
