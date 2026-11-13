<script setup lang="ts">
// Records list table. Columns: name, status (when the type has one),
// assigned avatars (when the type has a user_select field — list rows carry
// the assignment summary), a few leading jsonb-backed fields (list rows
// only carry the `data` jsonb map, so entry/channel/connection kinds can't
// render here), and updated-at. Rows navigate to the record detail; headers
// sort through the URL-bound list state.
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { RecordsFieldSetting } from '../../utils/field-kinds'
import type { RecordListItem } from '../../composables/useRecordsList'

const props = defineProps<{
  typeKey: string
  items: RecordListItem[]
  fields: RecordsFieldSetting[]
  loading?: boolean
  sort: string
  dir: 'asc' | 'desc'
}>()

const emit = defineEmits<{
  toggleSort: [field: string]
}>()

const typePath = useRecordsTypePath()

const UButton = resolveComponent('UButton')
const UBadge = resolveComponent('UBadge')

// Kinds whose values live in records_entries.data and render from a list row.
const JSONB_LIST_KINDS = new Set(['text', 'textarea', 'number', 'boolean', 'date', 'datetime', 'key_select'])

const statusField = computed(() =>
  props.fields.find(f => f.column === 'status') ?? null
)

// The first visible user_select field carries the assignment column; the
// list row's assignedTo summary spans every user field, which is close
// enough for a glanceable names cell.
const userField = computed(() =>
  props.fields.find(f => f.kind === 'user_select' && !f.hidden && !f.orphan) ?? null
)

const { byId: usersById, ensureUsers } = useRecordsUsers()
watch(userField, (f) => {
  if (f) {
    ensureUsers().catch(() => {
      // Avatars fall back to id initials until the directory loads.
    })
  }
}, { immediate: true })

// The fields endpoint returns fields sorted by order, so the first few
// non-promoted jsonb fields make the leading columns.
const leadingFields = computed(() =>
  props.fields
    .filter(f => !f.hidden && !f.orphan && !f.column && JSONB_LIST_KINDS.has(f.kind))
    .slice(0, 3)
)

const sortIcon = (field: string) => {
  if (props.sort !== field) return 'i-lucide-chevrons-up-down'
  return props.dir === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'
}

const sortableHeader = (label: string, field: string) => () =>
  h(UButton, {
    variant: 'ghost',
    color: 'neutral',
    size: 'xs',
    class: '-mx-2',
    trailingIcon: sortIcon(field),
    onClick: (e: MouseEvent) => {
      e.stopPropagation()
      emit('toggleSort', field)
    }
  }, () => label)

const columns = computed<TableColumn<RecordListItem>[]>(() => [
  {
    accessorKey: 'name',
    header: sortableHeader('Name', 'name'),
    cell: ({ row }) => h('span', { class: 'font-medium text-(--ui-text-highlighted)' }, row.original.name || '—')
  },
  ...(statusField.value
    ? [{
        accessorKey: 'status',
        header: sortableHeader('Status', 'status'),
        cell: ({ row }: { row: { original: RecordListItem } }) => {
          const key = row.original.status
          if (!key) return h('span', { class: 'text-(--ui-text-muted)' }, '—')
          return h(UBadge, {
            color: recordsOptionColor(statusField.value!, key),
            variant: 'subtle',
            size: 'sm'
          }, () => recordsOptionLabel(statusField.value!, key))
        }
      } as TableColumn<RecordListItem>]
    : []),
  ...(userField.value
    ? [{
        id: 'assigned',
        header: userField.value.label,
        cell: ({ row }: { row: { original: RecordListItem } }) => {
          const ids = row.original.assignedTo
          if (ids.length === 0) return h('span', { class: 'text-(--ui-text-muted)' }, '—')
          const names = ids.map(id => usersById.value.get(id)?.name ?? id).join(', ')
          return h('span', { class: 'text-sm truncate max-w-40 inline-block align-middle', title: names }, names)
        }
      } as TableColumn<RecordListItem>]
    : []),
  ...leadingFields.value.map(field => ({
    id: field.key,
    header: sortableHeader(field.label, field.key),
    cell: ({ row }: { row: { original: RecordListItem } }) =>
      formatRecordsValue(row.original.data[field.key], field)
  } as TableColumn<RecordListItem>)),
  {
    accessorKey: 'updatedAt',
    header: sortableHeader('Updated', 'updated_at'),
    cell: ({ row }) => formatDateTime(row.original.updatedAt)
  }
])

function handleRowSelect(_event: Event, row: { original: RecordListItem }) {
  navigateTo(typePath(props.typeKey, row.original.id))
}
</script>

<template>
  <UTable
    :columns="columns"
    :data="items"
    :loading="loading"
    :ui="{ tr: 'cursor-pointer' }"
    empty="No records match."
    @select="handleRowSelect"
  />
</template>
