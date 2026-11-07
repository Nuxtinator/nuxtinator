<script setup lang="ts" generic="T extends string">
// A choice among a few kinds (a layout, how a board gets its columns) as a
// row of cards, each with an icon and a name.
export interface ViewsChoiceCard<V extends string = string> {
  value: V
  label: string
  icon: string
}

const props = defineProps<{
  items: ViewsChoiceCard<T>[]
  disabled?: boolean
}>()

const model = defineModel<T>({ required: true })

const radioItems = computed(() => props.items as ViewsChoiceCard[])
const value = computed<string>({
  get: () => model.value,
  set: (v) => { model.value = v as T }
})

const columns = computed(() => props.items.length === 3 ? 'grid-cols-3' : 'grid-cols-2')
</script>

<template>
  <URadioGroup
    v-model="value"
    :items="radioItems"
    variant="card"
    indicator="hidden"
    :disabled="disabled"
    :ui="{
      fieldset: `grid ${columns} gap-2`,
      item: 'justify-center has-data-[state=checked]:bg-(--ui-primary)/5',
      icon: 'size-5 text-(--ui-text-muted)'
    }"
  />
</template>
