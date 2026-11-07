<script setup lang="ts">
// One rule of the filter builder: field, operator, and a value editor that
// fits the field's kind — options for selects, people (with "Me") for user
// fields, records for connections, dates, numbers, or free text. Changing
// the field or operator resets the value to that shape's empty value.
import {
  RECORDS_FILTER_ME,
  RECORDS_FILTER_OP_LABELS,
  RECORDS_FILTER_VALUE_SHAPE,
  recordsFilterOps
} from '#records'
import type { RecordsFilterOp, RecordsFilterRule } from '#records/client'
import type { ViewsFilterField } from '../../utils/views-filters'

const props = defineProps<{
  rule: RecordsFilterRule
  fields: ViewsFilterField[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:rule': [rule: RecordsFilterRule]
  'remove': []
}>()

const field = computed(() => props.fields.find(f => f.key === props.rule.field) ?? null)
const ops = computed(() => field.value ? recordsFilterOps(field.value.kind) : [])
const shape = computed(() => RECORDS_FILTER_VALUE_SHAPE[props.rule.op])

const fieldItems = computed(() => props.fields.map(f => ({ label: f.label, value: f.key })))
const opItems = computed(() => ops.value.map(op => ({ label: RECORDS_FILTER_OP_LABELS[op], value: op })))

function update(patch: Partial<RecordsFilterRule>) {
  emit('update:rule', { ...props.rule, ...patch })
}

function onField(key: string) {
  const next = props.fields.find(f => f.key === key)
  if (!next) return
  const op = recordsFilterOps(next.kind)[0]!
  emit('update:rule', viewsEmptyRule(key, op, next.kind))
}

function onOp(op: RecordsFilterOp) {
  if (!field.value) return
  const keep = RECORDS_FILTER_VALUE_SHAPE[op] === shape.value
  emit('update:rule', keep ? { ...props.rule, op } : viewsEmptyRule(props.rule.field, op, field.value.kind))
}

// --- value editors -------------------------------------------------------------

const { users, ensureUsers } = useRecordsUsers()
const optionItems = computed(() => {
  const f = field.value
  if (!f) return []
  if (f.kind === 'user_select') {
    return [
      { label: 'Me', value: RECORDS_FILTER_ME },
      ...users.value.map(u => ({ label: u.name, value: u.id }))
    ]
  }
  if (f.kind === 'connection') return targetItems.value
  return Object.entries(f.options ?? {})
    .filter(([, o]) => !o.deleted)
    .map(([key, o]) => ({ label: o.label, value: key }))
})

const usesOptions = computed(() => {
  const kind = field.value?.kind
  return kind === 'key_select' || kind === 'multi_select' || kind === 'user_select' || kind === 'connection'
})

// Connection rules pick records of the target type.
const targetItems = ref<Array<{ label: string, value: string }>>([])
watch(() => field.value?.kind === 'connection' ? field.value.target : null, async (target) => {
  targetItems.value = []
  if (!target) return
  try {
    const res = await $fetch<{ items: Array<{ id: string, name: string }> }>(`/api/records/entries/${target}`, {
      query: { limit: 100, sort: 'name', dir: 'asc' }
    })
    targetItems.value = res.items.map(r => ({ label: r.name, value: r.id }))
  } catch {
    // The picker stays empty; the rule can still be removed.
  }
}, { immediate: true })

watch(() => field.value?.kind, (kind) => {
  if (kind === 'user_select') {
    ensureUsers().catch(() => {
      // Only "Me" is offered until the directory loads.
    })
  }
}, { immediate: true })

const inputType = computed(() => {
  const kind = field.value?.kind
  if (kind === 'date' || kind === 'datetime') return 'date'
  if (kind === 'number') return 'number'
  return 'text'
})

function coerce(raw: string): string | number {
  return inputType.value === 'number' && raw !== '' ? Number(raw) : raw
}

const single = computed<string>({
  get: () => props.rule.value === undefined || props.rule.value === null ? '' : String(props.rule.value),
  set: v => update({ value: coerce(v) })
})

const singleOption = computed<string | undefined>({
  get: () => typeof props.rule.value === 'string' && props.rule.value !== '' ? props.rule.value : undefined,
  set: v => update({ value: v ?? '' })
})

const list = computed<string[]>({
  get: () => Array.isArray(props.rule.value) ? props.rule.value.map(String) : [],
  set: v => update({ value: v })
})

const rangeFrom = computed<string>({
  get: () => Array.isArray(props.rule.value) ? String(props.rule.value[0] ?? '') : '',
  set: v => update({ value: [coerce(v), Array.isArray(props.rule.value) ? props.rule.value[1] ?? '' : ''] })
})
const rangeTo = computed<string>({
  get: () => Array.isArray(props.rule.value) ? String(props.rule.value[1] ?? '') : '',
  set: v => update({ value: [Array.isArray(props.rule.value) ? props.rule.value[0] ?? '' : '', coerce(v)] })
})

const BOOLEAN_ITEMS = [
  { label: 'Yes', value: true },
  { label: 'No', value: false }
]
const booleanValue = computed<boolean>({
  get: () => props.rule.value === true,
  set: v => update({ value: v })
})
</script>

<template>
  <div class="flex items-start gap-2 flex-wrap sm:flex-nowrap">
    <USelectMenu
      :model-value="rule.field"
      :items="fieldItems"
      value-key="value"
      label-key="label"
      size="sm"
      class="w-40 shrink-0"
      :disabled="readonly"
      @update:model-value="onField($event as string)"
    />
    <USelect
      :model-value="rule.op"
      :items="opItems"
      size="sm"
      class="w-36 shrink-0"
      :disabled="readonly"
      @update:model-value="onOp($event as RecordsFilterOp)"
    />

    <div class="flex-1 min-w-40">
      <template v-if="shape === 'none'" />

      <USelect
        v-else-if="field?.kind === 'boolean'"
        v-model="booleanValue"
        :items="BOOLEAN_ITEMS"
        size="sm"
        class="w-full"
        :disabled="readonly"
      />

      <USelectMenu
        v-else-if="usesOptions && shape === 'list'"
        v-model="list"
        :items="optionItems"
        value-key="value"
        label-key="label"
        multiple
        size="sm"
        placeholder="Choose…"
        class="w-full"
        :disabled="readonly"
      />

      <USelectMenu
        v-else-if="usesOptions"
        v-model="singleOption"
        :items="optionItems"
        value-key="value"
        label-key="label"
        size="sm"
        placeholder="Choose…"
        class="w-full"
        :disabled="readonly"
      />

      <UInputTags
        v-else-if="shape === 'list'"
        v-model="list"
        size="sm"
        placeholder="Type and press Enter"
        class="w-full"
        :disabled="readonly"
      />

      <div
        v-else-if="shape === 'range'"
        class="flex items-center gap-2"
      >
        <UInput
          v-model="rangeFrom"
          :type="inputType"
          size="sm"
          class="flex-1"
          :disabled="readonly"
        />
        <span class="text-xs text-(--ui-text-muted)">and</span>
        <UInput
          v-model="rangeTo"
          :type="inputType"
          size="sm"
          class="flex-1"
          :disabled="readonly"
        />
      </div>

      <UInput
        v-else
        v-model="single"
        :type="inputType"
        size="sm"
        class="w-full"
        :disabled="readonly"
      />
    </div>

    <UButton
      v-if="!readonly"
      icon="i-lucide-x"
      variant="ghost"
      color="neutral"
      size="sm"
      aria-label="Remove rule"
      @click="emit('remove')"
    />
  </div>
</template>
