<script setup lang="ts">
// The schema builder's extra inputs for connection fields (registered in
// plugins/register-records-ui.ts): which record type the field links to, and
// whether the link nests one type's records under the other's. Both are
// locked after the field is created.
const model = defineModel<Record<string, unknown>>({ default: () => ({}) })

defineProps<{
  readonly?: boolean
  disabled?: boolean
}>()

const { types, ensureTypes } = useRecordsTypes()

onMounted(() => {
  // A load failure leaves the picker empty; submit stays disabled.
  ensureTypes().catch(() => {})
})

const items = computed(() =>
  types.value.filter(t => !t.orphan).map(t => ({ label: t.label, value: t.key })))

const target = computed({
  get: () => typeof model.value.target === 'string' ? model.value.target : undefined,
  set: (v: string | undefined) => { model.value = { ...model.value, target: v } }
})

const NESTING_ITEMS = [
  { value: 'none', label: 'No nesting', description: 'A plain link between records.' },
  { value: 'children', label: 'They sit under this', description: 'The linked records sit under this one, like a deliverable\'s tasks.' },
  { value: 'parent', label: 'This sits under them', description: 'This record sits under the one it links to.' }
]

// "No nesting" leaves the key out, so a plain connection sends nothing extra.
const nesting = computed({
  get: () => model.value.nesting === 'children' || model.value.nesting === 'parent' ? model.value.nesting : 'none',
  set: (v: string) => {
    const { nesting: _dropped, ...rest } = model.value
    model.value = v === 'none' ? rest : { ...rest, nesting: v }
  }
})
const nestingLabel = computed(() => NESTING_ITEMS.find(i => i.value === nesting.value)?.label)
</script>

<template>
  <UFormField
    label="Links to"
    :required="!readonly"
    :help="readonly ? undefined : 'The record type this field points at. Locked after the field is created.'"
  >
    <USelectMenu
      v-if="!readonly"
      v-model="target"
      :items="items"
      value-key="value"
      label-key="label"
      placeholder="Pick a record type"
      class="w-full"
      :disabled="disabled"
    />
    <UBadge
      v-else
      variant="subtle"
      color="neutral"
    >
      {{ items.find(t => t.value === target)?.label ?? target }}
    </UBadge>
  </UFormField>

  <UFormField v-if="!readonly || nesting !== 'none'">
    <template #label>
      Nesting
      <InfoTip>
        <p>Nested records open as a board of their own, and whoever can see a record sees everything under it.</p>
        <p>The matching field is added to the other record type. Locked after the field is created.</p>
      </InfoTip>
    </template>
    <URadioGroup
      v-if="!readonly"
      v-model="nesting"
      :items="NESTING_ITEMS"
      variant="card"
      :disabled="disabled"
    />
    <UBadge
      v-else
      variant="subtle"
      color="neutral"
    >
      {{ nestingLabel }}
    </UBadge>
  </UFormField>
</template>
