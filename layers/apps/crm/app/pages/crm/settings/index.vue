<script setup lang="ts">
// CRM schema settings — the org-level catalog of record types plus the
// channel-type list. Reachable by anyone with the URL but functionally
// gated on crm.schema.manage: the server reports the caller's access via
// the channel-types read (there is no client-side org-permission store to
// ask), and every write route enforces the permission regardless.
import type { CrmTypeSummary } from '../../../composables/useCrmTypes'

definePageMeta({ middleware: 'auth' })

const { types, ensureTypes } = useCrmTypes()
const admin = useCrmSchemaAdmin()
const crmPath = useCrmPath()

const sidebarOpen = ref(false)
const { shown: sidebarShown } = useCrmSidebar()
const ready = ref(false)
const pageError = ref<string | null>(null)

onMounted(async () => {
  await Promise.all([
    ensureTypes().catch((err) => {
      pageError.value = crmErrorMessage(err, 'Failed to load record types')
    }),
    admin.ensureAccess()
  ])
  ready.value = true
})

const canManage = admin.canManage

// Sorted for the catalog: code types first (registration order preserved),
// then custom, then stale rows.
const catalog = computed(() => {
  const rank = (t: CrmTypeSummary) => (t.orphan ? 2 : (t.custom ? 1 : 0))
  return [...types.value].sort((a, b) => rank(a) - rank(b))
})

const togglingKey = ref<string | null>(null)
async function toggleHidden(type: CrmTypeSummary, hidden: boolean) {
  togglingKey.value = type.key
  pageError.value = null
  try {
    await admin.updateType(type.key, { hidden })
  } catch (err) {
    pageError.value = crmErrorMessage(err, 'Failed to update record type')
  } finally {
    togglingKey.value = null
  }
}

const createOpen = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)

async function onCreate(payload: { typeKey: string, label: string, labelSingular: string, icon: string | null }) {
  creating.value = true
  createError.value = null
  try {
    const created = await admin.createType({
      typeKey: payload.typeKey,
      label: payload.label,
      labelSingular: payload.labelSingular,
      icon: payload.icon ?? undefined
    })
    createOpen.value = false
    await navigateTo(crmPath(`/settings/types/${created.key}`))
  } catch (err) {
    createError.value = crmErrorMessage(err, 'Failed to create record type')
  } finally {
    creating.value = false
  }
}

function openType(type: CrmTypeSummary) {
  navigateTo(crmPath(`/settings/types/${type.key}`))
}
</script>

<template>
  <div class="flex h-[calc(100vh-57px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6 lg:-my-8">
    <CrmSidebar v-model:open="sidebarOpen" />

    <section
      class="flex-1 flex flex-col min-w-0 border-l-0 border-(--ui-border) overflow-hidden"
      :class="{ 'lg:border-l': sidebarShown }"
    >
      <header class="flex items-center gap-2 px-4 py-3 border-b border-(--ui-border) bg-(--ui-bg)">
        <UButton
          v-if="sidebarShown"
          class="lg:hidden"
          icon="i-lucide-menu"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Open record types"
          @click="sidebarOpen = true"
        />
        <h1 class="flex-1 text-lg font-semibold truncate">
          CRM settings
        </h1>
        <UButton
          v-if="canManage"
          icon="i-lucide-plus"
          @click="createOpen = true"
        >
          New type
        </UButton>
      </header>

      <div class="flex-1 overflow-y-auto p-4 space-y-8">
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
          description="You need the 'Manage CRM schema' permission to change record types and fields."
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

          <section class="space-y-3">
            <div>
              <h2 class="text-base font-semibold">
                Channel types
              </h2>
              <p class="text-sm text-(--ui-text-muted)">
                Ways of reaching a contact — email, phone, and any custom channels you add.
              </p>
            </div>
            <CrmSettingsChannelTypeList />
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
              :to="crmPath('/settings/permissions')"
            >
              Open roles &amp; permissions
            </UButton>
          </section>
        </template>
      </div>
    </section>

    <UModal v-model:open="createOpen">
      <template #content>
        <div class="p-6 space-y-4">
          <h2 class="text-lg font-semibold">
            New record type
          </h2>
          <UAlert
            v-if="createError"
            color="error"
            :title="createError"
          />
          <CrmSettingsTypeForm
            mode="create"
            :busy="creating"
            @submit="onCreate"
            @cancel="createOpen = false"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
