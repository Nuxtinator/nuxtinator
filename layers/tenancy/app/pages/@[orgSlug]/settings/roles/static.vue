<script setup lang="ts">
definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()
const confirmAction = useConfirm()

interface StaticRole {
  key: string
  name: string
  description: string
  source: 'host' | 'app'
  permissions: string[]
}
interface PermissionItem {
  perm: string
  title: string
  description: string
}
type Effect = 'grant' | 'revoke'
interface OverrideRow {
  permission: string
  effect: Effect
}

const { data: staticData } = await useFetch<{ roles: StaticRole[] }>(
  () => `/api/o/${orgSlug.value}/static-roles`,
  { watch: [orgSlug], default: () => ({ roles: [] }) }
)
const { data: permsData } = await useFetch<{ permissions: PermissionItem[] }>(
  () => `/api/o/${orgSlug.value}/permissions`,
  { watch: [orgSlug], default: () => ({ permissions: [] }) }
)

const staticRoles = computed(() => staticData.value?.roles ?? [])
const allPerms = computed(() => permsData.value?.permissions ?? [])

const selectedRoleKey = ref<string>('')
watch(staticRoles, (rs) => {
  if (rs.length > 0 && !selectedRoleKey.value) {
    selectedRoleKey.value = rs[0]!.key
  }
}, { immediate: true })

const selectedRole = computed(() => staticRoles.value.find(r => r.key === selectedRoleKey.value) ?? null)
const basePerms = computed(() => new Set(selectedRole.value?.permissions ?? []))

// Edit state per role: rows currently in `org_role_overrides`. We keep a local
// map from perm → 'grant' | 'revoke' | undefined; the user toggles cells in a
// 3-state checkbox (default → grant → revoke → default).
const overridesByRole = ref<Record<string, Map<string, Effect>>>({})
const loadingRole = ref(false)

const fetchOverrides = async (key: string) => {
  if (!key) return
  loadingRole.value = true
  try {
    const r = await $fetch<{ overrides: OverrideRow[] }>(
      `/api/o/${orgSlug.value}/role-overrides`,
      { query: { role: key } }
    )
    const m = new Map<string, Effect>()
    for (const row of r.overrides) m.set(row.permission, row.effect)
    overridesByRole.value = { ...overridesByRole.value, [key]: m }
  } catch (err: unknown) {
    toast.add({
      title: 'Failed to load overrides',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    loadingRole.value = false
  }
}

watch(selectedRoleKey, (k) => {
  if (k) fetchOverrides(k)
}, { immediate: true })

const currentOverrides = computed(() => overridesByRole.value[selectedRoleKey.value] ?? new Map<string, Effect>())

// Effective state for a given permission row, given base + override map.
type CellState = 'on' | 'off' | 'granted' | 'revoked'
const stateFor = (perm: string): CellState => {
  const ov = currentOverrides.value.get(perm)
  const inBase = basePerms.value.has(perm)
  if (ov === 'grant') return 'granted'
  if (ov === 'revoke') return 'revoked'
  return inBase ? 'on' : 'off'
}

// Toggle cycles default → opposite-of-base → default.
//   in-base, no override → revoke
//   in-base, revoke → default
//   not-in-base, no override → grant
//   not-in-base, grant → default
const onToggle = (perm: string) => {
  if (!selectedRoleKey.value) return
  const k = selectedRoleKey.value
  const next = new Map(currentOverrides.value)
  const inBase = basePerms.value.has(perm)
  const cur = next.get(perm)
  if (cur) next.delete(perm)
  else next.set(perm, inBase ? 'revoke' : 'grant')
  overridesByRole.value = { ...overridesByRole.value, [k]: next }
}

const saving = ref(false)
const onSave = async () => {
  if (!selectedRoleKey.value) return
  const grants: string[] = []
  const revokes: string[] = []
  for (const [perm, eff] of currentOverrides.value.entries()) {
    if (eff === 'grant') grants.push(perm)
    else if (eff === 'revoke') revokes.push(perm)
  }

  saving.value = true
  try {
    await $fetch(`/api/o/${orgSlug.value}/role-overrides`, {
      method: 'PUT',
      body: { role: selectedRoleKey.value, grants, revokes }
    })
    toast.add({ title: 'Overrides saved', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Save failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

const onReset = async () => {
  if (!selectedRoleKey.value) return
  if (!await confirmAction({
    title: `Reset all overrides for "${selectedRole.value?.name}"?`,
    description: 'The role returns to its static defaults.',
    confirmLabel: 'Reset'
  })) return
  try {
    await $fetch(`/api/o/${orgSlug.value}/role-overrides`, {
      method: 'DELETE',
      query: { role: selectedRoleKey.value }
    })
    overridesByRole.value = { ...overridesByRole.value, [selectedRoleKey.value]: new Map() }
    toast.add({ title: 'Overrides reset', color: 'success' })
  } catch (err: unknown) {
    toast.add({
      title: 'Reset failed',
      description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
      color: 'error'
    })
  }
}

const labelFor = (s: CellState) => ({
  on: 'In base',
  off: '—',
  granted: 'Added (+)',
  revoked: 'Removed (−)'
}[s])
</script>

<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <header class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 class="text-3xl font-bold">
          Static role overrides
        </h1>
        <p class="text-sm text-(--ui-text-muted)">
          Add or remove permissions on top of each static role's defaults — scoped to this organization.
        </p>
      </div>
      <UButton
        variant="outline"
        :to="`/@${orgSlug}/settings/roles`"
        icon="i-lucide-arrow-left"
      >
        Back to roles
      </UButton>
    </header>

    <div class="flex flex-wrap gap-2">
      <UButton
        v-for="r in staticRoles"
        :key="r.key"
        :variant="selectedRoleKey === r.key ? 'solid' : 'outline'"
        size="sm"
        @click="selectedRoleKey = r.key"
      >
        {{ r.name }}
      </UButton>
    </div>

    <div
      v-if="loadingRole"
      class="text-sm text-(--ui-text-muted)"
    >
      Loading...
    </div>

    <template v-else-if="selectedRole">
      <div class="text-xs text-(--ui-text-muted)">
        Click a row to cycle its state. <span class="font-medium">In base</span> = static default;
        <span class="font-medium">+</span> = override grant; <span class="font-medium">−</span> = override revoke.
      </div>

      <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
        <li
          v-for="p in allPerms"
          :key="p.perm"
          class="flex items-center justify-between gap-3 p-3 cursor-pointer hover:bg-(--ui-bg-elevated)"
          @click="onToggle(p.perm)"
        >
          <div class="min-w-0">
            <div class="font-medium font-mono text-sm">
              {{ p.perm }}
            </div>
            <div
              v-if="p.title || p.description"
              class="text-xs text-(--ui-text-muted)"
            >
              {{ p.title }}<span v-if="p.description"> — {{ p.description }}</span>
            </div>
          </div>
          <UBadge
            :color="stateFor(p.perm) === 'granted' ? 'success'
              : stateFor(p.perm) === 'revoked' ? 'error'
                : stateFor(p.perm) === 'on' ? 'primary' : 'neutral'"
            variant="subtle"
            size="sm"
          >
            {{ labelFor(stateFor(p.perm)) }}
          </UBadge>
        </li>
      </ul>

      <div class="flex gap-2 justify-end">
        <UButton
          variant="ghost"
          color="error"
          @click="onReset"
        >
          Reset all overrides
        </UButton>
        <UButton
          :loading="saving"
          @click="onSave"
        >
          Save overrides
        </UButton>
      </div>
    </template>
  </div>
</template>
