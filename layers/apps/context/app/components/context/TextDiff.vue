<script setup lang="ts">
// Word-level diff of two texts: the full text with removed words struck
// through in red and added words highlighted in green.
import { diffWords } from 'diff'

const props = defineProps<{ before: string, after: string }>()

const chunks = computed(() => diffWords(props.before, props.after))
</script>

<template>
  <div class="whitespace-pre-wrap font-mono">
    <span
      v-for="(chunk, i) in chunks"
      :key="i"
      :class="chunk.added
        ? 'rounded-sm bg-(--ui-success)/15 text-(--ui-success)'
        : chunk.removed ? 'rounded-sm bg-(--ui-error)/15 text-(--ui-error) line-through' : ''"
      v-text="chunk.value"
    />
  </div>
</template>
