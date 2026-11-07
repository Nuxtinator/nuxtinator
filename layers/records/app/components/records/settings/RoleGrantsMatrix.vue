<script setup lang="ts">
// Per-type role grants matrix: pick a record type, get a grid of roles
// (rows) × record actions (columns) where every non-admin cell is a
// tri-state toggle cycling Inherit → Allow → Deny. Inherit renders the
// role's slug-fallback answer muted (the server's `fallback` per cell) so
// the resting state is honest; Allow/Deny are explicit override rows. Save
// PUTs the full grants object — the server stores only explicit entries.
// The admin row is locked always-allow: admins bypass the matrix entirely,
// and personal extra grants are additive, so neither can be denied here.
import type { RecordsRoleGrantsView } from '../../../composables/useRecordsPermissionsAdmin'

const props = defineProps<{
  /** Fixed record type; when set the type picker is hidden. */
  typeKey?: string
}>()

const { types, ensureTypes } = useRecordsTypes()
const { getRoleGrants, saveRoleGrants } = useRecordsPermissionsAdmin()
const orgKey = useRecordsOrgKey()

const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  share: 'Share',
  view_all: 'View all'
}

type CellState = 'inherit' | 'allow' | 'deny'

const selectedType = ref<string | undefined>(props.typeKey)
watch(() => props.typeKey, (key) => {
  if (key) selectedType.value = key
})
const view = ref<RecordsRoleGrantsView | null>(null)
const draft = ref<Record<string, Record<string, boolean>>>({})
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)

// Orphan rows have no live routes to grant against; the server 404s them.
const typeItems = computed(() =>
  types.value.filter(t => !t.orphan).map(t => ({ label: t.label, value: t.key }))
)

onMounted(async () => {
  try {
    await ensureTypes()
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to load record types')
  }
  if (!selectedType.value && typeItems.value.length > 0) {
    selectedType.value = typeItems.value[0]!.value
  }
})

function draftFrom(grants: Record<string, Record<string, boolean>>): Record<string, Record<string, boolean>> {
  return Object.fromEntries(Object.entries(grants).map(([role, actions]) => [role, { ...actions }]))
}

// Keyed on the org as well as the type: org switching is SPA navigation and
// keeps this component alive, so the fetch must re-run (dev.md gotcha 11).
watch([selectedType, orgKey], async ([typeKey]) => {
  view.value = null
  draft.value = {}
  error.value = null
  if (!typeKey) return
  loading.value = true
  const current = () => typeKey === selectedType.value
  try {
    const res = await getRoleGrants(typeKey)
    if (current()) {
      view.value = res
      draft.value = draftFrom(res.grants)
    }
  } catch (err) {
    if (current()) error.value = recordsErrorMessage(err, 'Failed to load role grants')
  } finally {
    if (current()) loading.value = false
  }
}, { immediate: true })

function stateOf(role: string, action: string): CellState {
  const row = draft.value[role]?.[action]
  if (row === true) return 'allow'
  if (row === false) return 'deny'
  return 'inherit'
}

function fallbackOf(role: string, action: string): boolean {
  return view.value?.effective[role]?.[action]?.fallback ?? false
}

function cycle(role: string, action: string) {
  const state = stateOf(role, action)
  const next = { ...(draft.value[role] ?? {}) }
  if (state === 'inherit') next[action] = true
  else if (state === 'allow') next[action] = false
  else delete next[action]
  draft.value = { ...draft.value, [role]: next }
}

function cellIcon(role: string, action: string): string {
  const state = stateOf(role, action)
  const allowed = state === 'inherit' ? fallbackOf(role, action) : state === 'allow'
  return allowed ? 'i-lucide-check' : 'i-lucide-x'
}

function cellClass(role: string, action: string): string {
  const state = stateOf(role, action)
  if (state === 'inherit') {
    return 'text-(--ui-text-muted) opacity-40'
  }
  return state === 'allow' ? 'text-(--ui-success)' : 'text-(--ui-error)'
}

function cellTitle(role: string, action: string): string {
  const state = stateOf(role, action)
  const fallback = fallbackOf(role, action) ? 'allowed' : 'denied'
  if (state === 'inherit') return `Inherit — ${fallback} by role permissions. Click to allow.`
  if (state === 'allow') return 'Always allow for this type. Click to deny.'
  return 'Always deny for this type (personal extra grants still apply). Click to inherit.'
}

// Only explicit entries count — a role whose overrides were all cleared
// drops out entirely, matching what the server persists.
const cleanedDraft = computed(() => {
  const out: Record<string, Record<string, boolean>> = {}
  for (const [role, actions] of Object.entries(draft.value)) {
    if (Object.keys(actions).length > 0) out[role] = actions
  }
  return out
})

const dirty = computed(() =>
  JSON.stringify(cleanedDraft.value) !== JSON.stringify(view.value?.grants ?? {})
)

async function save() {
  if (!selectedType.value) return
  saving.value = true
  error.value = null
  try {
    const res = await saveRoleGrants(selectedType.value, cleanedDraft.value)
    view.value = res
    draft.value = draftFrom(res.grants)
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to save role grants')
  } finally {
    saving.value = false
  }
}

function reset() {
  if (view.value) draft.value = draftFrom(view.value.grants)
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-3 flex-wrap">
      <USelect
        v-if="!props.typeKey"
        v-model="selectedType"
        :items="typeItems"
        class="w-56"
        aria-label="Record type"
      />
      <div class="flex-1" />
      <UButton
        v-if="dirty"
        color="neutral"
        variant="ghost"
        size="sm"
        :disabled="saving"
        @click="reset"
      >
        Reset
      </UButton>
      <UButton
        size="sm"
        :loading="saving"
        :disabled="!dirty"
        @click="save"
      >
        Save
      </UButton>
    </div>

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <div
      v-if="loading"
      class="grid place-items-center py-12 text-(--ui-text-muted)"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-5 animate-spin"
      />
    </div>

    <div
      v-else-if="view"
      class="overflow-x-auto border border-(--ui-border) rounded-md"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-(--ui-border) bg-(--ui-bg-elevated)/50">
            <th class="text-left font-medium px-3 py-2">
              Role
            </th>
            <th
              v-for="action in view.actions"
              :key="action"
              class="text-center font-medium px-2 py-2"
            >
              {{ ACTION_LABELS[action] ?? action }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr
            v-for="role in view.roles"
            :key="role.key"
          >
            <td class="px-3 py-1.5">
              <div class="flex items-center gap-2">
                <span class="truncate">{{ role.label }}</span>
                <UIcon
                  v-if="role.key === 'admin'"
                  name="i-lucide-lock"
                  class="size-3.5 text-(--ui-text-muted)"
                />
                <UBadge
                  v-if="role.custom"
                  variant="subtle"
                  color="primary"
                  size="sm"
                >
                  Custom
                </UBadge>
              </div>
            </td>
            <td
              v-for="action in view.actions"
              :key="action"
              class="text-center px-2 py-1.5"
            >
              <UIcon
                v-if="role.key === 'admin'"
                name="i-lucide-check"
                class="size-4 text-(--ui-text-muted)"
                title="Admins always have full access"
              />
              <UButton
                v-else
                :icon="cellIcon(role.key, action)"
                color="neutral"
                variant="ghost"
                size="xs"
                :class="cellClass(role.key, action)"
                :title="cellTitle(role.key, action)"
                :aria-label="`${role.label} / ${ACTION_LABELS[action] ?? action}: ${stateOf(role.key, action)}`"
                @click="cycle(role.key, action)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="text-xs text-(--ui-text-muted)">
      Muted marks inherit the role's permission slugs; colored marks are explicit
      Allow / Deny overrides for this type. Admins always pass, and per-user extra
      grants are additive — a Deny here can't remove them.
    </p>
  </div>
</template>
