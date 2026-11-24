<script setup lang="ts">
// A timestamp shown as compact relative text ("3h ago", then the date). Hover shows the full date
// and time; a tap or click switches every timestamp on the page to exact times until the next reload,
// which is how touch screens reach them. `hoverOnly` drops the tap, for timestamps inside a clickable row.
import type { TimestampValue } from '../utils/relative-time'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ value: TimestampValue, hoverOnly?: boolean }>()

const exact = useState<boolean>('relative-time-exact', () => false)

const date = computed(() => timestampDate(props.value))
const text = computed(() => date.value ? (exact.value ? exactTimeText(date.value) : relativeTimeText(date.value)) : '')
</script>

<template>
  <UTooltip v-if="date" :text="fullTimeText(date)">
    <span v-if="hoverOnly" v-bind="$attrs" class="whitespace-nowrap">
      <time :datetime="date.toISOString()">{{ text }}</time>
    </span>
    <button
      v-else
      v-bind="$attrs"
      type="button"
      class="whitespace-nowrap cursor-pointer decoration-dotted underline-offset-2 hover:underline"
      :aria-pressed="exact"
      @click.stop="exact = !exact"
    >
      <time :datetime="date.toISOString()">{{ text }}</time>
    </button>
  </UTooltip>
</template>
