<script setup lang="ts">
import VueApexCharts from 'vue3-apexcharts'
import type { InsightsResponse } from '../../utils/list-of-100-types'

type WindowKey = '30d' | 'all'

const win = ref<WindowKey>('30d')
const data = ref<InsightsResponse | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await $fetch<InsightsResponse>('/api/list-of-100/insights', {
      query: { window: win.value }
    })
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(win, load)

const chartType = computed<'bar' | 'line'>(() =>
  win.value === '30d' ? 'bar' : 'line'
)

const series = computed(() => {
  const points = data.value?.series ?? []
  return [
    { name: 'Contacted', data: points.map(p => p.contacted) },
    { name: 'Prayed', data: points.map(p => p.prayed) }
  ]
})

const categories = computed(() => (data.value?.series ?? []).map(p => p.day))

const options = computed(() => ({
  chart: {
    id: 'list-of-100-insights',
    toolbar: { show: false },
    fontFamily: 'inherit',
    foreColor: 'var(--ui-text-muted)'
  },
  colors: ['var(--ui-info)', 'var(--ui-success)'],
  dataLabels: { enabled: false },
  legend: { position: 'top' as const, horizontalAlign: 'left' as const },
  grid: {
    borderColor: 'var(--ui-border)',
    strokeDashArray: 4
  },
  plotOptions: chartType.value === 'bar'
    ? { bar: { columnWidth: '70%', borderRadius: 3 } }
    : {},
  stroke: chartType.value === 'line'
    ? { curve: 'smooth' as const, width: 2 }
    : { width: 1 },
  markers: { size: chartType.value === 'line' ? 3 : 0 },
  xaxis: {
    categories: categories.value,
    type: 'category' as const,
    labels: {
      rotate: -45,
      hideOverlappingLabels: true,
      formatter: (val: string) => {
        if (!val) return ''
        const d = new Date(val)
        if (Number.isNaN(d.getTime())) return val
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      }
    },
    axisBorder: { color: 'var(--ui-border)' },
    axisTicks: { color: 'var(--ui-border)' }
  },
  yaxis: {
    min: 0,
    forceNiceScale: true,
    labels: { formatter: (v: number) => Math.round(v).toString() }
  },
  tooltip: {
    // Force dark text on light bg, then CSS below paints both with our tokens
    // so it adapts to color mode and the global `foreColor` doesn't bleed in.
    theme: 'light' as const,
    x: {
      formatter: (val: number) => {
        const day = categories.value[val - 1]
        if (!day) return ''
        const d = new Date(day)
        if (Number.isNaN(d.getTime())) return day
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      }
    }
  }
}))

const totals = computed(() => {
  const points = data.value?.series ?? []
  return {
    contacted: points.reduce((s, p) => s + p.contacted, 0),
    prayed: points.reduce((s, p) => s + p.prayed, 0),
    days: points.length
  }
})

const windowItems = [
  { label: '30 days', value: '30d' as const },
  { label: 'All time', value: 'all' as const }
]
const windowModel = computed({
  get: () => win.value,
  set: (v: WindowKey) => { win.value = v }
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="text-lg font-semibold">
          Daily rhythm
        </h2>
        <p class="text-sm text-(--ui-text-muted)">
          Contacts and prayers logged per day.
        </p>
      </div>
      <UTabs
        v-model="windowModel"
        :items="windowItems"
        :content="false"
        size="sm"
        color="primary"
      />
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div class="rounded-lg border border-(--ui-border) p-3">
        <div class="text-xs text-(--ui-text-muted) uppercase tracking-wide">
          Contacts
        </div>
        <div class="mt-1 text-xl font-semibold tabular-nums">
          {{ totals.contacted }}
        </div>
      </div>
      <div class="rounded-lg border border-(--ui-border) p-3">
        <div class="text-xs text-(--ui-text-muted) uppercase tracking-wide">
          Prayers
        </div>
        <div class="mt-1 text-xl font-semibold tabular-nums">
          {{ totals.prayed }}
        </div>
      </div>
      <div class="rounded-lg border border-(--ui-border) p-3">
        <div class="text-xs text-(--ui-text-muted) uppercase tracking-wide">
          Days
        </div>
        <div class="mt-1 text-xl font-semibold tabular-nums">
          {{ totals.days }}
        </div>
      </div>
    </div>

    <div class="rounded-lg border border-(--ui-border) p-3 insights-chart">
      <div v-if="loading" class="py-16 text-center text-sm text-(--ui-text-muted)">
        Loading…
      </div>
      <ClientOnly v-else>
        <VueApexCharts
          :type="chartType"
          height="320"
          :options="options"
          :series="series"
        />
        <template #fallback>
          <div class="py-16 text-center text-sm text-(--ui-text-muted)">
            Loading chart…
          </div>
        </template>
      </ClientOnly>
    </div>
  </div>
</template>

<style scoped>
/* Re-skin the apexcharts tooltip to use Nuxt UI tokens so it stays readable
   in both color modes. Global `chart.foreColor` would otherwise tint the
   tooltip text with the same muted color used for axis labels — light text
   on light background. */
.insights-chart :deep(.apexcharts-tooltip) {
  background: var(--ui-bg);
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.08);
}
.insights-chart :deep(.apexcharts-tooltip-title) {
  background: var(--ui-bg-muted);
  color: var(--ui-text);
  border-bottom: 1px solid var(--ui-border);
  font-weight: 500;
}
.insights-chart :deep(.apexcharts-tooltip-series-group) {
  color: var(--ui-text);
}
.insights-chart :deep(.apexcharts-tooltip-text-y-label),
.insights-chart :deep(.apexcharts-tooltip-text-y-value) {
  color: var(--ui-text);
}
.insights-chart :deep(.apexcharts-xaxistooltip),
.insights-chart :deep(.apexcharts-yaxistooltip) {
  background: var(--ui-bg);
  color: var(--ui-text);
  border-color: var(--ui-border);
}
</style>
