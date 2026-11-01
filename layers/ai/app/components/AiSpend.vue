<script setup lang="ts">
import type { AiUsageSummary, AiUsageTotals } from '#ai'

// The org's AI spend: period totals, a bar per day for the last 30 days, this
// month by feature, and a log of the days that had calls.

const props = defineProps<{ orgSlug: string }>()

const { data: usage, pending } = await useFetch<AiUsageSummary>('/api/ai/org/usage', {
  watch: [() => props.orgSlug],
  key: () => `org-ai-usage-${props.orgSlug}`
})

const periods = computed(() => usage.value
  ? [
      { label: 'This month', totals: usage.value.month },
      { label: 'Last month', totals: usage.value.lastMonth },
      { label: 'All time', totals: usage.value.allTime }
    ]
  : [])

const daily = computed<AiUsageSummary['daily']>(() => usage.value?.daily ?? [])
const maxDay = computed(() => Math.max(0, ...daily.value.map(d => d.cost)))
const activeDays = computed(() => daily.value.filter(d => d.calls > 0).slice().reverse())

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

function barHeight(cost: number): string {
  return maxDay.value > 0 ? `${Math.max((cost / maxDay.value) * 100, cost > 0 ? 2 : 0)}%` : '0%'
}
</script>

<template>
  <div class="space-y-8">
    <div
      v-if="pending && !usage"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <template v-else-if="usage">
      <section class="space-y-3">
        <p class="text-sm text-(--ui-text-muted)">
          What this organization's AI features have cost, in US dollars, whichever key paid.
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
          Daily spend, last 30 days
        </h2>
        <div class="border border-(--ui-border) rounded-md p-4 space-y-2">
          <div class="flex items-baseline justify-between text-xs text-(--ui-text-muted)">
            <span>{{ maxDay > 0 ? `Highest day ${usd(maxDay)}` : 'No spend in the last 30 days' }}</span>
          </div>
          <div
            class="h-32 flex items-stretch gap-0.5 border-b border-(--ui-border)"
            role="img"
            :aria-label="`Daily AI spend for the last ${daily.length} days; highest day ${usd(maxDay)}. The table below lists each day.`"
          >
            <UTooltip
              v-for="d in daily"
              :key="d.day"
              :text="`${dayLabel(d.day, true)} · ${usd(d.cost)} · ${callsLabel(d)}`"
              :content="{ side: 'top' }"
            >
              <div class="flex-1 min-w-0 h-full flex flex-col justify-end group cursor-default">
                <div
                  class="w-full rounded-t-[4px] bg-(--ui-primary) group-hover:opacity-80"
                  :style="{ height: barHeight(d.cost) }"
                />
              </div>
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

      <section
        v-if="usage.monthByFeature.length"
        class="space-y-3"
      >
        <h2 class="text-lg font-semibold">
          This month by feature
        </h2>
        <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
          <li
            v-for="f in usage.monthByFeature"
            :key="f.feature"
            class="flex items-center justify-between gap-3 px-4 py-2 text-sm"
          >
            <div class="min-w-0">
              <div class="truncate">
                {{ f.label }}
              </div>
              <div class="text-xs text-(--ui-text-muted)">
                {{ callsLabel(f) }}
              </div>
            </div>
            <div class="font-medium tabular-nums shrink-0">
              {{ usd(f.cost) }}
            </div>
          </li>
        </ul>
      </section>

      <section class="space-y-3">
        <h2 class="text-lg font-semibold">
          Usage log
        </h2>
        <p
          v-if="!activeDays.length"
          class="text-sm text-(--ui-text-muted)"
        >
          No AI calls in the last 30 days.
        </p>
        <table
          v-else
          class="w-full text-sm border border-(--ui-border) rounded-md"
        >
          <thead>
            <tr class="text-xs text-(--ui-text-muted) text-left">
              <th class="font-normal px-4 py-2">
                Day
              </th>
              <th class="font-normal px-4 py-2 text-right">
                Calls
              </th>
              <th class="font-normal px-4 py-2 text-right">
                Spend
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--ui-border)">
            <tr
              v-for="d in activeDays"
              :key="d.day"
            >
              <td class="px-4 py-2">
                {{ dayLabel(d.day, true) }}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">
                {{ d.calls.toLocaleString() }}<span
                  v-if="d.unpriced"
                  class="text-(--ui-text-muted)"
                > ({{ d.unpriced }} unpriced)</span>
              </td>
              <td class="px-4 py-2 text-right tabular-nums font-medium">
                {{ usd(d.cost) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="activeDays.length"
          class="text-xs text-(--ui-text-muted)"
        >
          Days with no AI calls are left out.
        </p>
      </section>
    </template>
  </div>
</template>
