<script setup lang="ts">
// The filter builder: rules and groups of rules one level deep, each level
// matching all or any of its children. Edits a draft and saves the whole
// tree at once; Clear saves no filter. A tab's builder shows the view's base
// filter read-only above it, since the tab only narrows it. People who can
// only view see the same modal read-only.
import { isRecordsFilterGroup, recordsFilterOps, recordsFilterRuleCount } from '#records'
import type { RecordsFieldSetting, RecordsFilterGroup, RecordsFilterNode, RecordsFilterRule } from '#records/client'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  title: string
  fields: RecordsFieldSetting[]
  filter: RecordsFilterGroup | null
  /** The view's base filter, shown read-only when editing a tab's. */
  base?: RecordsFilterGroup | null
  readonly?: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  save: [filter: RecordsFilterGroup | null]
}>()

const filterFields = computed(() => viewsFilterFields(props.fields))

const draft = ref<RecordsFilterGroup>({ match: 'all', rules: [] })
watch(open, (v) => {
  if (v) draft.value = structuredClone(toRaw(props.filter) ?? { match: 'all', rules: [] })
})

const MATCH_ITEMS = [
  { label: 'all', value: 'all' },
  { label: 'any', value: 'any' }
]

function newRule(): RecordsFilterRule {
  const first = filterFields.value[0]!
  return viewsEmptyRule(first.key, recordsFilterOps(first.kind)[0]!, first.kind)
}

function addRule(group: RecordsFilterGroup) {
  group.rules.push(newRule())
}

function addGroup() {
  draft.value.rules.push({ match: 'any', rules: [newRule()] })
}

function setNode(group: RecordsFilterGroup, index: number, node: RecordsFilterNode) {
  group.rules.splice(index, 1, node)
}

function removeNode(group: RecordsFilterGroup, index: number) {
  group.rules.splice(index, 1)
  // A group left empty goes with its last rule.
  if (group !== draft.value && group.rules.length === 0) {
    const at = draft.value.rules.indexOf(group)
    if (at >= 0) draft.value.rules.splice(at, 1)
  }
}

const complete = computed(() => viewsFilterComplete(draft.value))
const baseCount = computed(() => recordsFilterRuleCount(props.base))

function save() {
  if (!complete.value) return
  emit('save', draft.value.rules.length > 0 ? structuredClone(toRaw(draft.value)) : null)
}

function clear() {
  emit('save', null)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <div
          v-if="base && baseCount > 0"
          class="rounded-lg border border-dashed border-(--ui-border) p-3 space-y-2 opacity-75"
        >
          <p class="text-xs font-medium text-(--ui-text-muted) flex items-center gap-1">
            <UIcon
              name="i-lucide-lock"
              class="size-3.5"
            />
            The view's filter (applies to every tab)
          </p>
          <ViewsFilterGroupEditor
            :group="base"
            :fields="filterFields"
            readonly
          />
        </div>

        <div class="flex items-center gap-2 text-sm">
          <span>Show records matching</span>
          <USelect
            v-model="draft.match"
            :items="MATCH_ITEMS"
            size="sm"
            class="w-20"
            :disabled="readonly"
          />
          <span>of these:</span>
        </div>

        <p
          v-if="draft.rules.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          No filter — every record shows.
        </p>

        <div class="space-y-2">
          <template
            v-for="(node, i) in draft.rules"
            :key="i"
          >
            <div
              v-if="isRecordsFilterGroup(node)"
              class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated)/50 p-3 space-y-2"
            >
              <div class="flex items-center gap-2 text-sm">
                <span>Matching</span>
                <USelect
                  v-model="node.match"
                  :items="MATCH_ITEMS"
                  size="sm"
                  class="w-20"
                  :disabled="readonly"
                />
                <span>of:</span>
                <span class="flex-1" />
                <UButton
                  v-if="!readonly"
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Remove group"
                  @click="draft.rules.splice(i, 1)"
                />
              </div>
              <ViewsFilterRuleRow
                v-for="(rule, j) in node.rules"
                :key="j"
                :rule="rule as RecordsFilterRule"
                :fields="filterFields"
                :readonly="readonly"
                @update:rule="setNode(node, j, $event)"
                @remove="removeNode(node, j)"
              />
              <UButton
                v-if="!readonly"
                icon="i-lucide-plus"
                variant="ghost"
                size="xs"
                @click="addRule(node)"
              >
                Add rule
              </UButton>
            </div>
            <ViewsFilterRuleRow
              v-else
              :rule="node"
              :fields="filterFields"
              :readonly="readonly"
              @update:rule="setNode(draft, i, $event)"
              @remove="removeNode(draft, i)"
            />
          </template>
        </div>

        <div
          v-if="!readonly"
          class="flex gap-2"
        >
          <UButton
            icon="i-lucide-plus"
            variant="outline"
            color="neutral"
            size="sm"
            :disabled="filterFields.length === 0"
            @click="addRule(draft)"
          >
            Add rule
          </UButton>
          <UButton
            icon="i-lucide-brackets"
            variant="outline"
            color="neutral"
            size="sm"
            :disabled="filterFields.length === 0"
            @click="addGroup"
          >
            Add group
          </UButton>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full gap-2">
        <UButton
          v-if="!readonly && filter"
          variant="ghost"
          color="neutral"
          :disabled="saving"
          @click="clear"
        >
          Clear filter
        </UButton>
        <span class="flex-1" />
        <UButton
          variant="ghost"
          :disabled="saving"
          @click="open = false"
        >
          {{ readonly ? 'Close' : 'Cancel' }}
        </UButton>
        <UButton
          v-if="!readonly"
          :loading="saving"
          :disabled="!complete"
          @click="save"
        >
          Save
        </UButton>
      </div>
    </template>
  </UModal>
</template>
