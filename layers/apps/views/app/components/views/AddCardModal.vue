<script setup lang="ts">
// Custom-board "add existing record": name search over the view's record
// type, records already on the board disabled. Opens when a column key is
// set (the column whose footer/menu asked for it).
import type { ViewsTabView } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  /** Record ids already placed on the board. */
  onBoard: string[]
}>()

const columnKey = defineModel<string | null>('columnKey', { default: null })

const emit = defineEmits<{
  added: []
}>()

interface SearchItem {
  id: string
  name: string
  status: string | null
}

const q = ref('')
const results = ref<SearchItem[]>([])
const searching = ref(false)
const addError = ref<string | null>(null)
const addingId = ref<string | null>(null)

const open = computed({
  get: () => columnKey.value !== null,
  set: (v) => {
    if (!v) columnKey.value = null
  }
})

const onBoardSet = computed(() => new Set(props.onBoard))

let requestId = 0
async function search() {
  const id = ++requestId
  searching.value = true
  try {
    const res = await $fetch<{ items: SearchItem[] }>(
      `/api/records/entries/${props.view.recordTypeKey}`,
      { query: { q: q.value || undefined, limit: 10 } }
    )
    if (id !== requestId) return
    results.value = res.items
    addError.value = null
  } catch (err) {
    if (id !== requestId) return
    addError.value = recordsErrorMessage(err, 'Search failed')
  } finally {
    if (id === requestId) searching.value = false
  }
}

watch(open, (v) => {
  if (v) {
    q.value = ''
    addError.value = null
    search()
  }
})
watch(q, () => {
  if (open.value) search()
})

async function add(recordId: string) {
  if (addingId.value || columnKey.value === null) return
  addingId.value = recordId
  try {
    await $fetch(`/api/views/${props.view.id}/cards`, {
      method: 'POST',
      body: { recordId, tabId: props.view.tabId, columnKey: columnKey.value || undefined }
    })
    emit('added')
    open.value = false
  } catch (err) {
    addError.value = recordsErrorMessage(err, 'Failed to add the record')
  } finally {
    addingId.value = null
  }
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <div class="p-6 space-y-4">
        <h2 class="text-lg font-semibold">
          Add a record to the board
        </h2>

        <UInput
          v-model="q"
          autofocus
          icon="i-lucide-search"
          placeholder="Search records…"
          class="w-full"
        />

        <UAlert
          v-if="addError"
          color="error"
          :title="addError"
        />

        <ul
          v-else-if="results.length > 0"
          class="divide-y divide-(--ui-border) rounded-lg border border-(--ui-border) max-h-72 overflow-y-auto"
        >
          <li
            v-for="item in results"
            :key="item.id"
          >
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-(--ui-bg-elevated) disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="onBoardSet.has(item.id) || addingId !== null"
              @click="add(item.id)"
            >
              <span class="flex-1 truncate">{{ item.name }}</span>
              <UBadge
                v-if="onBoardSet.has(item.id)"
                variant="subtle"
                color="neutral"
              >
                On board
              </UBadge>
            </button>
          </li>
        </ul>

        <p
          v-else-if="!searching"
          class="text-sm text-(--ui-text-muted) text-center py-4"
        >
          No records found.
        </p>
      </div>
    </template>
  </UModal>
</template>
