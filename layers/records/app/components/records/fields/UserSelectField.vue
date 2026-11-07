<script setup lang="ts">
// Inline user picker: async search over the org user directory. A single
// field commits a user id (or null); a multiple field commits the full id
// array (the server replaces the list). Selected users render as avatar
// chips below the select.
import type { RecordsFieldSetting } from '../../../utils/field-kinds'
import type { RecordsUser } from '../../../composables/useRecordsUsers'

const props = defineProps<{
  field: RecordsFieldSetting
  modelValue: unknown
}>()

const emit = defineEmits<{
  commit: [value: string[] | string | null]
}>()

const { users, byId, ensureUsers, searchUsers } = useRecordsUsers()

const searchTerm = ref('')
const results = ref<RecordsUser[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    await ensureUsers()
    results.value = users.value
  } catch {
    // An empty picker communicates the failure; commits validate server-side.
  } finally {
    loading.value = false
  }
})

let timer: ReturnType<typeof setTimeout> | null = null
watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    loading.value = true
    try {
      results.value = await searchUsers(q)
    } catch {
      // Keep the previous results on a failed search.
    } finally {
      loading.value = false
    }
  }, 250)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const selectedIds = computed<string[]>(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue.map(String)
  if (typeof props.modelValue === 'string' && props.modelValue !== '') return [props.modelValue]
  return []
})

interface UserItem {
  label: string
  value: string
  avatar?: { src?: string, alt: string }
}

type SingleUserItem = Omit<UserItem, 'value'> & { value: string | null }

function toItem(u: RecordsUser): UserItem {
  return { label: u.name, value: u.id, avatar: { src: u.avatarUrl || undefined, alt: u.name } }
}

// Search results plus any current selections the search filtered out, so
// selected values always render with a label.
const items = computed<UserItem[]>(() => {
  const out = results.value.map(toItem)
  for (const id of selectedIds.value) {
    if (out.some(i => i.value === id)) continue
    const u = byId.value.get(id)
    out.push(u ? toItem(u) : { label: id, value: id })
  }
  return out
})

// Single optional fields get a leading "—" item that commits null.
const singleItems = computed<SingleUserItem[]>(() =>
  props.field.required ? items.value : [{ label: '—', value: null }, ...items.value]
)

const selectedUsers = computed(() =>
  selectedIds.value.map(id => byId.value.get(id) ?? { id, name: id, email: '', avatarUrl: null })
)

function onMultiple(value: string[]) {
  emit('commit', value)
}

function onSingle(value: string | null | undefined) {
  const next = typeof value === 'string' && value !== '' ? value : null
  if (next === (selectedIds.value[0] ?? null)) return
  emit('commit', next)
}
</script>

<template>
  <div class="space-y-2">
    <USelectMenu
      v-if="field.multiple"
      v-model:search-term="searchTerm"
      :model-value="selectedIds"
      :items="items"
      multiple
      ignore-filter
      :loading="loading"
      value-key="value"
      label-key="label"
      placeholder="Select users..."
      class="w-full sm:max-w-xs"
      @update:model-value="onMultiple"
    />
    <USelectMenu
      v-else
      v-model:search-term="searchTerm"
      :model-value="selectedIds[0] ?? null"
      :items="singleItems"
      ignore-filter
      :loading="loading"
      value-key="value"
      label-key="label"
      placeholder="Select user..."
      class="w-full sm:max-w-xs"
      @update:model-value="onSingle"
    />
    <div
      v-if="selectedUsers.length > 0"
      class="flex flex-wrap gap-1.5"
    >
      <UBadge
        v-for="user in selectedUsers"
        :key="user.id"
        color="neutral"
        variant="subtle"
      >
        <UAvatar
          :src="user.avatarUrl || undefined"
          :alt="user.name"
          size="3xs"
        />
        {{ user.name }}
      </UBadge>
    </div>
  </div>
</template>
