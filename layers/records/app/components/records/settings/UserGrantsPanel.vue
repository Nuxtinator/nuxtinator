<script setup lang="ts">
// Per-user extra permissions: pick a user from the org directory, see their
// direct crm.* grants as removable chips, add more from the registered
// catalog. Extras are slug-level and additive on top of roles — the type
// matrix can never subtract them. Orphan grants (slug no longer registered,
// e.g. after a layer uninstall) render flagged and stay revocable.
import type { RecordsUser } from '../../../composables/useRecordsUsers'
import type { RecordsUserGrant, RecordsPermissionInfo } from '../../../composables/useRecordsPermissionsAdmin'

const toast = useToast()
const orgKey = useRecordsOrgKey()
const { users, ensureUsers, searchUsers } = useRecordsUsers()
const { ensureCatalog, getUserGrants, addUserGrant, removeUserGrant } = useRecordsPermissionsAdmin()

const selectedUserId = ref<string | undefined>(undefined)
const grants = ref<RecordsUserGrant[]>([])
const catalog = ref<RecordsPermissionInfo[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

// --- User picker (async search over the org directory) ----------------------

const searchTerm = ref('')
const results = ref<RecordsUser[]>([])
const searching = ref(false)

onMounted(async () => {
  searching.value = true
  try {
    const [, cat] = await Promise.all([ensureUsers(), ensureCatalog()])
    results.value = users.value
    catalog.value = cat
  } catch (err) {
    error.value = recordsErrorMessage(err, 'Failed to load users')
  } finally {
    searching.value = false
  }
})

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    searching.value = true
    try {
      results.value = await searchUsers(q)
    } catch {
      // Keep the previous results on a failed search.
    } finally {
      searching.value = false
    }
  }, 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

interface PickerItem {
  label: string
  value: string
  avatar?: { src?: string, alt: string }
}

const userItems = computed<PickerItem[]>(() =>
  results.value.map(u => ({
    label: u.name,
    value: u.id,
    avatar: { src: u.avatarUrl || undefined, alt: u.name }
  }))
)

// --- Grants ------------------------------------------------------------------

// Keyed on the org as well as the user: org switching keeps this component
// alive, and a user id from the previous org must not be re-queried.
watch([selectedUserId, orgKey], async ([userId], [, prevOrg]) => {
  if (prevOrg !== undefined && prevOrg !== orgKey.value) {
    selectedUserId.value = undefined
    grants.value = []
    return
  }
  grants.value = []
  error.value = null
  if (!userId) return
  loading.value = true
  const current = () => userId === selectedUserId.value
  try {
    const res = await getUserGrants(userId)
    if (current()) grants.value = res
  } catch (err) {
    if (current()) error.value = recordsErrorMessage(err, 'Failed to load grants')
  } finally {
    if (current()) loading.value = false
  }
})

// Already-granted slugs drop out of the add picker.
const grantedKeys = computed(() => new Set(grants.value.map(g => g.permission)))
const addItems = computed(() =>
  catalog.value
    .filter(p => !grantedKeys.value.has(p.key))
    .map(p => ({ label: p.title, value: p.key }))
)

const adding = ref(false)
async function onAdd(permission: string | null | undefined) {
  if (typeof permission !== 'string' || permission === '' || !selectedUserId.value) return
  adding.value = true
  try {
    grants.value = await addUserGrant(selectedUserId.value, permission)
  } catch (err) {
    toast.add({
      title: 'Grant failed',
      description: recordsErrorMessage(err, 'Failed to grant permission'),
      color: 'error'
    })
  } finally {
    adding.value = false
  }
}

const removingKey = ref<string | null>(null)
async function onRemove(permission: string) {
  if (!selectedUserId.value) return
  removingKey.value = permission
  try {
    grants.value = await removeUserGrant(selectedUserId.value, permission)
  } catch (err) {
    toast.add({
      title: 'Revoke failed',
      description: recordsErrorMessage(err, 'Failed to revoke permission'),
      color: 'error'
    })
  } finally {
    removingKey.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <USelectMenu
      v-model="selectedUserId"
      v-model:search-term="searchTerm"
      :items="userItems"
      ignore-filter
      :loading="searching"
      value-key="value"
      label-key="label"
      placeholder="Pick a user..."
      class="w-full max-w-md"
      aria-label="User"
    />

    <UAlert
      v-if="error"
      color="error"
      :title="error"
    />

    <template v-else-if="selectedUserId">
      <div
        v-if="loading"
        class="flex justify-center py-6 text-(--ui-text-muted)"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
      </div>

      <template v-else>
        <p
          v-if="grants.length === 0"
          class="text-sm text-(--ui-text-muted)"
        >
          No extra permissions granted.
        </p>
        <div
          v-else
          class="flex flex-wrap gap-2"
        >
          <UBadge
            v-for="grant in grants"
            :key="grant.permission"
            :color="grant.orphan ? 'warning' : 'neutral'"
            variant="subtle"
            size="lg"
            :title="grant.orphan ? `${grant.permission} — no longer registered; inert but revocable` : grant.permission"
          >
            {{ grant.title }}{{ grant.orphan ? ' (unregistered)' : '' }}
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="link"
              size="xs"
              :loading="removingKey === grant.permission"
              :aria-label="`Revoke ${grant.title}`"
              @click="onRemove(grant.permission)"
            />
          </UBadge>
        </div>

        <!-- model-value pinned to '' — the controlled-empty pattern from
             SharePopover: undefined would flip reka-ui to uncontrolled mode
             and stick the picked key as the rendered selection. Picking is
             handled entirely by @update:model-value; onAdd ignores the ''
             echo. The catalog is local, so the built-in filter applies. -->
        <USelectMenu
          :model-value="''"
          :items="addItems"
          :loading="adding"
          value-key="value"
          label-key="label"
          placeholder="Grant a permission..."
          class="w-full max-w-md"
          aria-label="Grant a permission"
          @update:model-value="onAdd"
        />
      </template>
    </template>

    <p class="text-xs text-(--ui-text-muted)">
      Extra grants are additive on top of the user's roles — a Deny in the type
      matrix can't remove them. To take one away, revoke it here.
    </p>
  </div>
</template>
