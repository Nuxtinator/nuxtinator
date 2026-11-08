<script setup lang="ts">
// Table renderer: name + the view's card fields as columns, read-only —
// clicking a row opens the slideover. Values come from the record row
// (status, timestamps, jsonb fields), from the side-table values the feed
// attaches for the chosen keys, or from the view's own field values, so any
// field of the type or the view can be a column.
// Headers toggle the sort for the fields the list engine can order on.
import type { RecordsFieldSetting } from '#records/client'
import type { ViewsBoardItem, ViewsTabView, ViewRecords } from '../../utils/views-types'

const props = defineProps<{
  view: ViewsTabView
  records: ViewRecords
  fields: RecordsFieldSetting[]
  sort: string | null
  dir: 'asc' | 'desc' | null
  pageSize: number
  pending?: boolean
  canCreate: boolean
}>()

const page = defineModel<number>('page', { default: 1 })

const emit = defineEmits<{
  toggleSort: [field: string]
  open: [recordId: string]
  quickAdd: [name: string]
}>()

const { byId: usersById, ensureUsers } = useRecordsUsers()
onMounted(() => {
  ensureUsers().catch(() => {
    // Avatars fall back silently.
  })
})
const userName = (id: string) => usersById.value.get(id)?.name ?? null

const fieldMap = computed(() => new Map(props.fields.map(f => [f.key, f])))

const INTRINSIC_LABELS: Record<string, string> = {
  status: 'Status',
  created_at: 'Created',
  updated_at: 'Updated'
}

interface TableColumnDef {
  key: string
  label: string
  sortable: boolean
  field: RecordsFieldSetting | null
}

const columns = computed<TableColumnDef[]>(() => {
  const chosen = props.records.card.fields
  const out: TableColumnDef[] = []
  for (const key of chosen) {
    if (key === 'name') continue
    if (key === 'created_at' || key === 'updated_at') {
      out.push({ key, label: INTRINSIC_LABELS[key]!, sortable: true, field: null })
      continue
    }
    const field = fieldMap.value.get(key)
      ?? (key === 'status' ? props.fields.find(f => f.column === 'status') ?? null : null)
    if (field) {
      const storage = viewsFieldStorage(field)
      out.push({
        key: field.key,
        label: field.label,
        // Side-table values have no column to ORDER BY.
        sortable: !!field.column || storage === 'jsonb',
        field
      })
    } else if (key === 'status') {
      out.push({ key, label: INTRINSIC_LABELS[key]!, sortable: true, field: null })
    }
  }
  return out
})

function cellText(item: ViewsBoardItem, column: TableColumnDef): string {
  if (column.key === 'created_at') return formatDate(item.createdAt)
  if (column.key === 'updated_at') return formatDate(item.updatedAt)
  const field = column.field
  if (!field) return item.status ?? '—'
  if (field.column === 'status') return field ? formatRecordsValue(item.status, field) : (item.status ?? '—')
  const raw = viewsIsViewField(field)
    ? item.viewValues?.[field.key] ?? null
    : viewsFieldStorage(field) === 'jsonb'
      ? item.data[field.key]
      : item.fields?.[field.key] ?? null
  if (field.kind === 'attachments') {
    const count = recordsAttachmentList(raw).length
    return count > 0 ? String(count) : '—'
  }
  return formatRecordsValue(raw, field, { userName })
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function sortIcon(column: TableColumnDef): string {
  if (props.sort !== column.key) return 'i-lucide-chevrons-up-down'
  return props.dir === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
}

const quickAddName = ref('')
function submitQuickAdd() {
  const value = quickAddName.value.trim()
  if (!value) return
  emit('quickAdd', value)
  quickAddName.value = ''
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-lg border border-(--ui-border) bg-(--ui-bg) overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-(--ui-border) text-left">
            <th class="px-3 py-2 font-medium">
              <button
                type="button"
                class="inline-flex items-center gap-1 hover:text-(--ui-text)"
                @click="emit('toggleSort', 'name')"
              >
                Name
                <UIcon
                  :name="sort === 'name' ? (dir === 'asc' ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down') : 'i-lucide-chevrons-up-down'"
                  class="size-3.5 opacity-60"
                />
              </button>
            </th>
            <th
              v-for="column in columns"
              :key="column.key"
              class="px-3 py-2 font-medium"
            >
              <button
                v-if="column.sortable"
                type="button"
                class="inline-flex items-center gap-1 hover:text-(--ui-text)"
                @click="emit('toggleSort', column.key)"
              >
                {{ column.label }}
                <UIcon
                  :name="sortIcon(column)"
                  class="size-3.5 opacity-60"
                />
              </button>
              <span v-else>{{ column.label }}</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--ui-border)">
          <tr
            v-for="item in records.items"
            :key="item.id"
            class="hover:bg-(--ui-bg-elevated) cursor-pointer"
            @click="emit('open', item.id)"
          >
            <td class="px-3 py-2 font-medium">
              {{ item.name }}
            </td>
            <td
              v-for="column in columns"
              :key="column.key"
              class="px-3 py-2 text-(--ui-text-muted)"
            >
              {{ cellText(item, column) }}
            </td>
          </tr>
          <tr v-if="records.items.length === 0 && !pending">
            <td
              :colspan="columns.length + 1"
              class="px-3 py-8 text-center text-(--ui-text-muted)"
            >
              No records match this view.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-between gap-2 flex-wrap">
      <form
        v-if="canCreate"
        class="flex items-center gap-2"
        @submit.prevent="submitQuickAdd"
      >
        <UInput
          v-model="quickAddName"
          size="sm"
          placeholder="New record name…"
        />
        <UButton
          type="submit"
          size="sm"
          icon="i-lucide-plus"
          :disabled="!quickAddName.trim()"
        >
          Add
        </UButton>
      </form>
      <span
        v-else
        class="text-sm text-(--ui-text-muted)"
      >
        {{ records.total }} record{{ records.total === 1 ? '' : 's' }}
      </span>
      <UPagination
        v-model:page="page"
        :items-per-page="pageSize"
        :total="records.total"
      />
    </div>
  </div>
</template>
