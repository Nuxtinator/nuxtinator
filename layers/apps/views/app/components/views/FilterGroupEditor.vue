<script setup lang="ts">
// A read-only rendering of a filter tree, used for the view's base filter
// inside a tab's filter builder.
import { isRecordsFilterGroup } from '#records'
import type { RecordsFilterGroup } from '#records/client'
import type { ViewsFilterField } from '../../utils/views-filters'

defineProps<{
  group: RecordsFilterGroup
  fields: ViewsFilterField[]
  readonly?: boolean
}>()
</script>

<template>
  <div class="space-y-2">
    <p class="text-xs text-(--ui-text-muted)">
      Matching {{ group.match }} of:
    </p>
    <template
      v-for="(node, i) in group.rules"
      :key="i"
    >
      <div
        v-if="isRecordsFilterGroup(node)"
        class="rounded-md border border-(--ui-border) p-2"
      >
        <ViewsFilterGroupEditor
          :group="node"
          :fields="fields"
          readonly
        />
      </div>
      <ViewsFilterRuleRow
        v-else
        :rule="node"
        :fields="fields"
        readonly
      />
    </template>
  </div>
</template>
