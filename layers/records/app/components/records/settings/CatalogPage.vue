<script setup lang="ts">
// Record-type settings — the org-level catalog of record types, then any
// sections other layers register (the crm layer's channel types). Rendered by
// the org settings shell (multi mode) and the host admin shell (single mode).
// Reachable by anyone with the URL but functionally gated on
// records.schema.manage: the server reports the caller's access via the
// types read (there is no client-side org-permission store to ask), and
// every write route enforces the permission regardless.
import { getRecordsSettingsSections } from '#records'
import type { RecordsTypeSummary } from '../../../composables/useRecordsTypes'

const { types, ensureTypes } = useRecordsTypes()
const admin = useRecordsSchemaAdmin()
const settingsPath = useRecordsSettingsPath()
const typePath = useRecordsTypePath()

const ready = ref(false)
const pageError = ref<string | null>(null)

onMounted(async () => {
  await Promise.all([
    ensureTypes().catch((err) => {
      pageError.value = recordsErrorMessage(err, 'Failed to load record types')
    }),
    admin.ensureAccess()
  ])
  ready.value = true
})

const canManage = admin.canManage
const extraSections = getRecordsSettingsSections()

// Sorted for the catalog: code types first (registration order preserved),
// then custom, then stale rows.
const catalog = computed(() => {
  const rank = (t: RecordsTypeSummary) => (t.orphan ? 2 : (t.custom ? 1 : 0))
  return [...types.value].sort((a, b) => rank(a) - rank(b))
})

const togglingKey = ref<string | null>(null)
async function toggleHidden(type: RecordsTypeSummary, hidden: boolean) {
  togglingKey.value = type.key
  pageError.value = null
  try {
    await admin.updateType(type.key, { hidden })
  } catch (err) {
    pageError.value = recordsErrorMessage(err, 'Failed to update record type')
  } finally {
    togglingKey.value = null
  }
}

const createOpen = ref(false)

function openType(type: RecordsTypeSummary) {
  navigateTo(settingsPath(`/types/${type.key}`))
}
</script>

<template>
  <div class="max-w-4xl mx-auto space-y-6">
    <PageTitle title="Records">
      <UButton
        v-if="canManage"
        icon="i-lucide-plus"
        @click="createOpen = true"
      >
        New type
      </UButton>
    </PageTitle>

    <div class="space-y-8">
      <div
        v-if="!ready"
        class="grid place-items-center py-24 text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-6 animate-spin"
        />
      </div>

      <UAlert
        v-else-if="!canManage"
        color="warning"
        icon="i-lucide-lock"
        title="Schema management requires permission"
        description="You need the 'Manage record types' permission to change record types and fields."
      />

      <template v-else>
        <UAlert
          v-if="pageError"
          color="error"
          :title="pageError"
        />

        <section class="space-y-3">
          <div>
            <h2 class="text-base font-semibold">
              Record types
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Code-shipped types can be relabeled, hidden, and extended with custom fields; custom types are fully yours.
            </p>
          </div>

          <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
            <li
              v-for="type in catalog"
              :key="type.key"
              class="flex items-center gap-3 px-3 py-2 hover:bg-(--ui-bg-elevated)/50 cursor-pointer"
              @click="openType(type)"
            >
              <UIcon
                :name="type.icon ?? 'i-lucide-folder'"
                class="size-4 shrink-0 text-(--ui-text-muted)"
              />
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium truncate">{{ type.label }}</span>
                  <UBadge
                    v-if="type.custom"
                    variant="subtle"
                    color="primary"
                    size="sm"
                  >
                    Custom
                  </UBadge>
                  <UBadge
                    v-if="type.orphan"
                    variant="subtle"
                    color="warning"
                    size="sm"
                    title="No code manifest backs this row"
                  >
                    Stale
                  </UBadge>
                </div>
                <span class="text-xs text-(--ui-text-muted) font-mono">{{ type.key }}</span>
              </div>
              <div
                class="shrink-0 flex items-center gap-3"
                @click.stop
              >
                <UButton
                  v-if="!type.orphan && !type.hidden && type.canRead"
                  icon="i-lucide-table"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  :to="typePath(type.key)"
                  :aria-label="`View ${type.label}`"
                  :title="`View ${type.label}`"
                />
                <USwitch
                  v-if="!type.orphan"
                  :model-value="!type.hidden"
                  :disabled="togglingKey === type.key"
                  :aria-label="`Toggle visibility of ${type.label}`"
                  @update:model-value="toggleHidden(type, !$event)"
                />
                <UIcon
                  name="i-lucide-chevron-right"
                  class="size-4 text-(--ui-text-muted)"
                />
              </div>
            </li>
            <li
              v-if="catalog.length === 0"
              class="px-3 py-6 text-sm text-(--ui-text-muted) text-center"
            >
              No record types yet.
            </li>
          </ul>
        </section>

        <section
          v-for="extra in extraSections"
          :key="extra.id"
          class="space-y-3"
        >
          <h2 class="text-base font-semibold">
            {{ extra.title }}
          </h2>
          <component :is="extra.component" />
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-base font-semibold">
              Roles &amp; permissions
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Per-type role access and per-user extra permissions.
            </p>
          </div>
          <UButton
            icon="i-lucide-shield"
            color="neutral"
            variant="outline"
            :to="settingsPath('/permissions')"
          >
            Open roles &amp; permissions
          </UButton>
        </section>
      </template>
    </div>

    <RecordsSettingsCreateTypeModal v-model:open="createOpen" />
  </div>
</template>
