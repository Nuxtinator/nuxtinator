<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const { updates, availableCount, checkNow, checking } = await useLayerUpdates()

type Row = (typeof updates.value)[number]

// One plain-language status per layer: a coloured label plus an optional
// version detail (e.g. "1.3.2 → 1.4.0"). No jargon, no repetition.
function status(u: Row): { label: string, color: 'primary' | 'warning' | 'success' | 'neutral', detail: string | null } {
  if (u.updateAvailable) return { label: 'Update available', color: 'primary', detail: `${u.current} → ${u.latestInRange}` }
  if (u.majorHeld) return { label: 'New major available', color: 'warning', detail: `${u.latest}` }
  if (u.current === null) return { label: 'Auto-updating', color: 'neutral', detail: null }
  if (u.latest === null) return { label: 'No releases yet', color: 'neutral', detail: null }
  return { label: 'Up to date', color: 'success', detail: u.current }
}

const rows = computed(() => updates.value.map(u => ({ ...u, s: status(u) })))

// Before any versions are published, every layer just follows the latest build.
const allAutoUpdating = computed(() => rows.value.length > 0 && rows.value.every(r => r.current === null))
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold flex items-center gap-2">
          Updates
          <UBadge
            v-if="availableCount > 0"
            color="primary"
            variant="subtle"
            size="sm"
          >
            {{ availableCount }} available
          </UBadge>
        </h1>
        <p class="text-sm text-(--ui-text-muted)">
          Versions available for the layers this app runs. Updates take effect on your next deploy.
        </p>
      </div>
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        size="sm"
        :loading="checking"
        @click="checkNow"
      >
        Check now
      </UButton>
    </header>

    <div
      v-if="rows.length === 0"
      class="text-sm text-(--ui-text-muted) border border-(--ui-border) rounded-md p-4"
    >
      No remote layers are tracked for this project.
    </div>

    <template v-else>
      <p
        v-if="allAutoUpdating"
        class="text-sm text-(--ui-text-muted)"
      >
        No published versions yet — every layer follows the latest build automatically.
      </p>

      <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
        <li
          v-for="r in rows"
          :key="r.id"
          class="flex items-center justify-between gap-3 p-4"
        >
          <div class="min-w-0">
            <div class="font-medium">
              {{ r.name }}
            </div>
            <div class="text-xs text-(--ui-text-muted)">
              {{ r.pkg }}
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UBadge
              v-for="u in r.unmet"
              :key="u.pkg"
              color="error"
              variant="subtle"
              :title="`This layer declares it needs ${u.pkg} ${u.range} (${u.loaded === null ? 'not installed' : `installed: ${u.loaded}`})`"
            >
              Needs {{ u.pkg.replace('@nuxtinator/', '') }} {{ u.range }}
            </UBadge>
            <div class="text-right">
              <UBadge
                :color="r.s.color"
                variant="subtle"
              >
                {{ r.s.label }}
              </UBadge>
              <div
                v-if="r.s.detail"
                class="text-xs text-(--ui-text-muted) mt-1"
              >
                {{ r.s.detail }}
              </div>
            </div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>
