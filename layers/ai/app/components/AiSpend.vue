<script setup lang="ts">
import type { AiUsageBreakdowns, AiUsageCall, AiUsageCalls, AiUsageGroup, AiUsagePeriod, AiUsageSummary, AiUsageTotals } from '#ai'

// AI spend: period totals, a bar per day for the last 30 days split by layer,
// the chosen period broken down by layer, feature, source, model, user, key source
// and (host view) org, and, for an org, a log of its recent calls.

const props = defineProps<{ view: 'org' | 'host', orgSlug?: string }>()

const period = ref<AiUsagePeriod>('month')
const periodItems: { label: string, value: AiUsagePeriod }[] = [
  { label: 'This month', value: 'month' },
  { label: 'Last month', value: 'last_month' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'All time', value: 'all' }
]

const { data: usage, pending } = await useFetch<AiUsageSummary>(
  props.view === 'host' ? '/api/ai/admin/usage' : '/api/ai/org/usage',
  {
    query: { period },
    watch: [() => props.orgSlug],
    key: () => props.view === 'host' ? `host-ai-usage-${period.value}` : `org-ai-usage-${props.orgSlug}-${period.value}`
  }
)

const periods = computed(() => usage.value
  ? [
      { label: 'This month', totals: usage.value.month },
      { label: 'Last month', totals: usage.value.lastMonth },
      { label: 'All time', totals: usage.value.allTime }
    ]
  : [])

// Seven layers get their own color in the daily chart; the rest share "Other".
const SERIES_SLOTS = 7
const OTHER = '__other'
const daily = computed<AiUsageSummary['daily']>(() => usage.value?.daily ?? [])
const series = computed(() => {
  const layers = usage.value?.dailyLayers ?? []
  const own = layers.slice(0, SERIES_SLOTS).map((l, i) => ({ key: l.key, label: l.label, color: `var(--ai-spend-series-${i + 1})` }))
  return layers.length > SERIES_SLOTS ? [...own, { key: OTHER, label: 'Other', color: 'var(--ai-spend-series-other)' }] : own
})
const seriesKeys = computed(() => new Set(series.value.map(s => s.key)))

function segments(d: AiUsageSummary['daily'][number]) {
  const costs = new Map<string, number>()
  for (const [layer, cost] of Object.entries(d.layers)) {
    const key = seriesKeys.value.has(layer) ? layer : OTHER
    costs.set(key, (costs.get(key) ?? 0) + cost)
  }
  return series.value.flatMap(s => (costs.get(s.key) ?? 0) > 0 ? [{ ...s, cost: costs.get(s.key)! }] : [])
}

const maxDay = computed(() => Math.max(0, ...daily.value.map(d => d.cost)))

type Dimension = keyof AiUsageBreakdowns
const dimension = ref<Dimension>('layer')
// Source appears once some call in the period recorded what it ran for.
const hasSubjects = computed(() => !!usage.value?.by.subject.some(g => g.key !== ''))
const dimensionItems = computed(() => [
  { label: 'Layer', value: 'layer' },
  { label: 'Feature', value: 'feature' },
  ...(hasSubjects.value ? [{ label: 'Source', value: 'subject' }] : []),
  { label: 'Model', value: 'model' },
  { label: 'User', value: 'user' },
  { label: 'Key', value: 'keySource' },
  ...(usage.value?.by.org ? [{ label: 'Organization', value: 'org' }] : [])
])
watch(dimensionItems, (items) => {
  if (!items.some(i => i.value === dimension.value)) dimension.value = 'layer'
})
const groups = computed<AiUsageGroup[]>(() => usage.value?.by[dimension.value] ?? [])
const groupMax = computed(() => Math.max(0, ...groups.value.map(g => g.cost)))

const calls = ref<AiUsageCall[]>([])
const nextCursor = ref<string | null>(null)
const loadingCalls = ref(false)
const callSubjects = computed(() => calls.value.some(c => c.subject))

async function loadCalls(more = false) {
  if (props.view !== 'org') return
  loadingCalls.value = true
  try {
    const res = await $fetch<AiUsageCalls>('/api/ai/org/usage-calls', { query: { cursor: more ? nextCursor.value ?? undefined : undefined } })
    calls.value = more ? [...calls.value, ...res.calls] : res.calls
    nextCursor.value = res.next
  } finally {
    loadingCalls.value = false
  }
}
watch(() => props.orgSlug, () => loadCalls(), { immediate: true })

// Small amounts keep four decimals so a month of cheap calls doesn't read as $0.00.
function usd(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 4 : 2 })
}

function callsLabel(t: AiUsageTotals): string {
  const calls = `${t.calls.toLocaleString()} ${t.calls === 1 ? 'call' : 'calls'}`
  return t.unpriced ? `${calls}, ${t.unpriced.toLocaleString()} without a known price` : calls
}

function dayLabel(day: string, weekday = false): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { ...(weekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' })
}

function timeLabel(at: string): string {
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function barHeight(cost: number): string {
  return maxDay.value > 0 ? `${Math.max((cost / maxDay.value) * 100, cost > 0 ? 2 : 0)}%` : '0%'
}
</script>

<template>
  <div class="ai-spend space-y-8">
    <div
      v-if="pending && !usage"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <template v-else-if="usage">
      <section class="space-y-3">
        <p class="text-sm text-(--ui-text-muted)">
          {{ view === 'host'
            ? 'What AI has cost across this deployment, every organization and personal app, in US dollars, whichever key paid.'
            : 'What this organization\'s AI features have cost, in US dollars, whichever key paid.' }}
        </p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div
            v-for="p in periods"
            :key="p.label"
            class="border border-(--ui-border) rounded-md p-4"
          >
            <div class="text-xs text-(--ui-text-muted)">
              {{ p.label }}
            </div>
            <div class="text-2xl font-semibold tabular-nums">
              {{ usd(p.totals.cost) }}
            </div>
            <div class="text-xs text-(--ui-text-muted)">
              {{ callsLabel(p.totals) }}
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">
          Daily spend by layer, last 30 days
        </h2>
        <div class="border border-(--ui-border) rounded-md p-4 space-y-2">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-(--ui-text-muted)">
            <span>{{ maxDay > 0 ? `Highest day ${usd(maxDay)}` : 'No spend in the last 30 days' }}</span>
            <ul
              v-if="series.length > 1"
              class="flex flex-wrap gap-x-3 gap-y-1"
            >
              <li
                v-for="s in series"
                :key="s.key"
                class="flex items-center gap-1.5"
              >
                <span
                  class="size-2.5 rounded-[2px]"
                  :style="{ background: s.color }"
                />
                {{ s.label }}
              </li>
            </ul>
          </div>
          <div
            class="h-32 flex items-stretch gap-0.5 border-b border-(--ui-border)"
            role="img"
            :aria-label="`Daily AI spend for the last ${daily.length} days, split by layer; highest day ${usd(maxDay)}. The breakdown below lists spend by layer.`"
          >
            <UTooltip
              v-for="d in daily"
              :key="d.day"
              :content="{ side: 'top' }"
              :ui="{ content: 'h-auto flex-col items-stretch gap-0.5 py-1.5' }"
            >
              <div class="flex-1 min-w-0 h-full flex flex-col justify-end group cursor-default">
                <div
                  class="w-full flex flex-col-reverse gap-0.5 rounded-t-[4px] overflow-hidden group-hover:opacity-80"
                  :style="{ height: barHeight(d.cost) }"
                >
                  <div
                    v-for="seg in segments(d)"
                    :key="seg.key"
                    class="w-full min-h-px"
                    :style="{ flex: `${seg.cost} 1 0`, background: seg.color }"
                  />
                </div>
              </div>
              <template #content>
                <div class="font-medium">
                  {{ dayLabel(d.day, true) }} · {{ usd(d.cost) }} · {{ callsLabel(d) }}
                </div>
                <div
                  v-for="seg in segments(d).slice().reverse()"
                  :key="seg.key"
                  class="flex items-center gap-1.5"
                >
                  <span
                    class="size-2 rounded-[2px]"
                    :style="{ background: seg.color }"
                  />
                  <span class="flex-1">{{ seg.label }}</span>
                  <span class="tabular-nums">{{ usd(seg.cost) }}</span>
                </div>
              </template>
            </UTooltip>
          </div>
          <div
            v-if="daily.length"
            class="flex justify-between text-xs text-(--ui-text-muted)"
          >
            <span>{{ dayLabel(daily[0]!.day) }}</span>
            <span>Today</span>
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg font-semibold">
            Breakdown
          </h2>
          <USelect
            v-model="period"
            :items="periodItems"
            size="sm"
            class="w-36"
          />
        </div>
        <UTabs
          v-model="dimension"
          :items="dimensionItems"
          :content="false"
          variant="link"
          size="sm"
          :ui="{ list: 'overflow-x-auto' }"
        />
        <p
          v-if="!groups.length"
          class="text-sm text-(--ui-text-muted)"
        >
          No AI calls in this period.
        </p>
        <ul
          v-else
          class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md"
        >
          <li
            v-for="g in groups"
            :key="g.key"
            class="px-4 py-2 text-sm space-y-1.5"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="truncate">
                  {{ g.label }}
                </div>
                <div class="text-xs text-(--ui-text-muted)">
                  {{ callsLabel(g) }}
                </div>
              </div>
              <div class="font-medium tabular-nums shrink-0">
                {{ usd(g.cost) }}
              </div>
            </div>
            <div
              v-if="groupMax > 0"
              class="h-1 rounded-full bg-(--ui-bg-elevated)"
            >
              <div
                class="h-full rounded-full bg-(--ui-primary)"
                :style="{ width: `${(g.cost / groupMax) * 100}%` }"
              />
            </div>
          </li>
        </ul>
      </section>

      <section
        v-if="view === 'org'"
        class="space-y-3"
      >
        <h2 class="text-lg font-semibold">
          Recent calls
        </h2>
        <p
          v-if="!calls.length && !loadingCalls"
          class="text-sm text-(--ui-text-muted)"
        >
          No AI calls yet.
        </p>
        <div
          v-else
          class="border border-(--ui-border) rounded-md overflow-x-auto"
        >
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-(--ui-text-muted) text-left">
                <th class="font-normal px-4 py-2">
                  When
                </th>
                <th class="font-normal px-4 py-2">
                  Feature
                </th>
                <th
                  v-if="callSubjects"
                  class="font-normal px-4 py-2"
                >
                  Source
                </th>
                <th class="font-normal px-4 py-2">
                  Model
                </th>
                <th class="font-normal px-4 py-2">
                  User
                </th>
                <th class="font-normal px-4 py-2 text-right">
                  Tokens in / out
                </th>
                <th class="font-normal px-4 py-2 text-right">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-(--ui-border)">
              <tr
                v-for="c in calls"
                :key="c.id"
              >
                <td class="px-4 py-2 whitespace-nowrap">
                  {{ timeLabel(c.at) }}
                </td>
                <td class="px-4 py-2">
                  {{ c.feature }}
                  <div class="text-xs text-(--ui-text-muted)">
                    {{ c.keySource }}
                  </div>
                </td>
                <td
                  v-if="callSubjects"
                  class="px-4 py-2"
                >
                  {{ c.subject ?? '—' }}
                </td>
                <td class="px-4 py-2 break-all">
                  {{ c.model }}
                </td>
                <td class="px-4 py-2">
                  {{ c.user }}
                </td>
                <td class="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                  {{ c.promptTokens.toLocaleString() }} / {{ c.completionTokens.toLocaleString() }}
                </td>
                <td class="px-4 py-2 text-right tabular-nums font-medium whitespace-nowrap">
                  {{ c.cost === null ? 'Unpriced' : usd(c.cost) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <UButton
          v-if="nextCursor"
          size="sm"
          variant="outline"
          color="neutral"
          :loading="loadingCalls"
          @click="loadCalls(true)"
        >
          Load more
        </UButton>
      </section>
    </template>
  </div>
</template>

<style>
/* Categorical series colors for the daily chart, stepped separately for each mode. */
.ai-spend {
  --ai-spend-series-1: #2a78d6;
  --ai-spend-series-2: #eb6834;
  --ai-spend-series-3: #1baf7a;
  --ai-spend-series-4: #eda100;
  --ai-spend-series-5: #e87ba4;
  --ai-spend-series-6: #008300;
  --ai-spend-series-7: #6250d6;
  --ai-spend-series-other: #a3a29d;
}
.dark .ai-spend {
  --ai-spend-series-1: #3987e5;
  --ai-spend-series-2: #d95926;
  --ai-spend-series-3: #199e70;
  --ai-spend-series-4: #c98500;
  --ai-spend-series-5: #d55181;
  --ai-spend-series-6: #008300;
  --ai-spend-series-7: #9085e9;
  --ai-spend-series-other: #6b6a65;
}
</style>
