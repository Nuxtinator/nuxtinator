<script setup lang="ts">
// Admin OAuth dashboard. Three stacked sections:
//   1. Registered Clients — toggle enabled, list counts, search.
//   2. Active Token Families — revoke individual families.
//   3. Recent OAuth Events — read-only audit log filtered to oauth.*
//
// Page is auto-discovered from the OAuth layer. Consumer must define
// the `admin` layout and `auth` + `admin` middleware (typical Nuxt
// admin setup).
//
// English-only, matches existing admin pages.

import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const UBadge = resolveComponent('UBadge')
const UButton = resolveComponent('UButton')
const USwitch = resolveComponent('USwitch')

const toast = useToast()

// ── Shared formatting ───────────────────────────────────────────────
const formatTimestamp = (iso: string | null): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

const truncate = (value: string, head = 8, tail = 4): string => {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

// ─────────────────────────────────────────────────────────────────────
// Section 1: Registered Clients
// ─────────────────────────────────────────────────────────────────────

interface ClientRow {
  client_id: string
  client_name: string
  dynamic: boolean
  enabled: boolean
  scope: string
  created: string
  active_consents: number
  active_families: number
}

interface ClientsResponse {
  rows: ClientRow[]
  total: number
  page: number
  pageSize: number
}

const clientsPage = ref(1)
const clientsPageSize = 25
const clientsSearch = ref('')

const clientsQueryKey = computed(() => ({
  page: clientsPage.value,
  pageSize: clientsPageSize,
  q: clientsSearch.value.trim()
}))

const {
  data: clientsData,
  pending: clientsPending,
  refresh: refreshClients
} = await useFetch<ClientsResponse>('/api/admin/oauth/clients', {
  query: clientsQueryKey,
  watch: [clientsQueryKey],
  default: () => ({ rows: [], total: 0, page: 1, pageSize: clientsPageSize })
})

// Local mirror of the enabled flag so the toggle reflects optimistic
// state; reconciles on refresh.
const clientToggling = ref<string | null>(null)

const toggleClientEnabled = async (row: ClientRow) => {
  clientToggling.value = row.client_id
  try {
    await $fetch(`/api/admin/oauth/clients/${encodeURIComponent(row.client_id)}`, {
      method: 'PATCH',
      body: { enabled: !row.enabled }
    })
    toast.add({
      title: row.enabled ? 'Client disabled' : 'Client enabled',
      description: row.client_name,
      color: 'success'
    })
    await refreshClients()
  } catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string }; statusMessage?: string })?.data?.statusMessage
      || (err as { statusMessage?: string })?.statusMessage
      || 'Failed to update client'
    toast.add({ title: 'Error', description: message, color: 'error' })
  } finally {
    clientToggling.value = null
  }
}

const clientColumns: TableColumn<ClientRow>[] = [
  {
    accessorKey: 'client_name',
    header: 'Name',
    cell: ({ row }) => h('div', { class: 'flex items-center gap-2' }, [
      h('span', { class: 'font-medium' }, row.original.client_name),
      row.original.dynamic
        ? h(UBadge, { color: 'neutral', variant: 'subtle', size: 'sm' }, () => 'DCR')
        : null
    ])
  },
  {
    accessorKey: 'client_id',
    header: 'Client ID',
    cell: ({ row }) => h('code', { class: 'text-xs text-(--ui-text-muted)' },
      truncate(row.original.client_id, 12, 6))
  },
  {
    accessorKey: 'active_consents',
    header: 'Consents',
    cell: ({ row }) => h('span', { class: 'text-sm' }, String(row.original.active_consents))
  },
  {
    accessorKey: 'active_families',
    header: 'Active families',
    cell: ({ row }) => h('span', { class: 'text-sm' }, String(row.original.active_families))
  },
  {
    accessorKey: 'created',
    header: 'Created',
    cell: ({ row }) => h('span', { class: 'text-sm text-(--ui-text-muted)' },
      formatTimestamp(row.original.created))
  },
  {
    accessorKey: 'enabled',
    header: 'Enabled',
    cell: ({ row }) => h(USwitch, {
      modelValue: row.original.enabled,
      loading: clientToggling.value === row.original.client_id,
      'onUpdate:modelValue': () => toggleClientEnabled(row.original)
    })
  }
]

// ─────────────────────────────────────────────────────────────────────
// Section 2: Active Token Families
// ─────────────────────────────────────────────────────────────────────

interface FamilyRow {
  family_id: string
  user_id: string
  user_email: string | null
  client_id: string
  client_name: string | null
  created: string
  last_used_at: string | null
  access_token_count: number
  refresh_token_count: number
}

interface FamiliesResponse {
  rows: FamilyRow[]
  total: number
  page: number
  pageSize: number
}

const familiesPage = ref(1)
const familiesPageSize = 25
const familiesSearch = ref('')

const familiesQueryKey = computed(() => ({
  page: familiesPage.value,
  pageSize: familiesPageSize,
  q: familiesSearch.value.trim()
}))

const {
  data: familiesData,
  pending: familiesPending,
  refresh: refreshFamilies
} = await useFetch<FamiliesResponse>('/api/admin/oauth/families', {
  query: familiesQueryKey,
  watch: [familiesQueryKey],
  default: () => ({ rows: [], total: 0, page: 1, pageSize: familiesPageSize })
})

const revokeFamilyTarget = ref<FamilyRow | null>(null)
const revokingFamily = ref(false)
const revokeFamilyOpen = computed({
  get: () => revokeFamilyTarget.value !== null,
  set: (v: boolean) => {
    if (!v && !revokingFamily.value) revokeFamilyTarget.value = null
  }
})

const requestRevokeFamily = (row: FamilyRow) => {
  revokeFamilyTarget.value = row
}

const handleRevokeFamily = async () => {
  if (!revokeFamilyTarget.value) return
  revokingFamily.value = true
  const target = revokeFamilyTarget.value
  try {
    await $fetch(`/api/admin/oauth/families/${encodeURIComponent(target.family_id)}`, {
      method: 'DELETE'
    })
    toast.add({
      title: 'Family revoked',
      description: `${target.client_name ?? target.client_id} for ${target.user_email ?? target.user_id}`,
      color: 'success'
    })
    await refreshFamilies()
    revokeFamilyTarget.value = null
  } catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string }; statusMessage?: string })?.data?.statusMessage
      || (err as { statusMessage?: string })?.statusMessage
      || 'Failed to revoke family'
    toast.add({ title: 'Error', description: message, color: 'error' })
  } finally {
    revokingFamily.value = false
  }
}

const familyColumns: TableColumn<FamilyRow>[] = [
  {
    accessorKey: 'family_id',
    header: 'Family ID',
    cell: ({ row }) => h('code', { class: 'text-xs text-(--ui-text-muted)' },
      truncate(row.original.family_id, 8, 4))
  },
  {
    accessorKey: 'user_email',
    header: 'User',
    cell: ({ row }) => h('span', { class: 'text-sm' },
      row.original.user_email ?? truncate(row.original.user_id, 8, 4))
  },
  {
    accessorKey: 'client_name',
    header: 'Client',
    cell: ({ row }) => h('span', { class: 'text-sm' },
      row.original.client_name ?? row.original.client_id)
  },
  {
    accessorKey: 'created',
    header: 'Created',
    cell: ({ row }) => h('span', { class: 'text-sm text-(--ui-text-muted)' },
      formatTimestamp(row.original.created))
  },
  {
    accessorKey: 'last_used_at',
    header: 'Last used',
    cell: ({ row }) => h('span', { class: 'text-sm text-(--ui-text-muted)' },
      formatTimestamp(row.original.last_used_at))
  },
  {
    accessorKey: 'access_token_count',
    header: 'Tokens',
    cell: ({ row }) => h('span', { class: 'text-sm' },
      `${row.original.access_token_count}A / ${row.original.refresh_token_count}R`)
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => h('div', { class: 'flex justify-end' }, [
      h(UButton, {
        color: 'error',
        variant: 'soft',
        size: 'sm',
        icon: 'i-lucide-shield-off',
        'aria-label': 'Revoke family',
        onClick: () => requestRevokeFamily(row.original)
      }, () => 'Revoke')
    ])
  }
]

// ─────────────────────────────────────────────────────────────────────
// Section 3: Recent OAuth Events
// ─────────────────────────────────────────────────────────────────────

interface EventRow {
  id: string
  timestamp: string
  event_type: string
  user_id: string | null
  user_email: string | null
  user_agent: string | null
  metadata: Record<string, unknown> | null
}

interface EventsResponse {
  rows: EventRow[]
  total: number
  page: number
  pageSize: number
}

const eventsPage = ref(1)
const eventsPageSize = 50

const eventsQueryKey = computed(() => ({
  page: eventsPage.value,
  pageSize: eventsPageSize
}))

const {
  data: eventsData,
  pending: eventsPending,
  refresh: refreshEvents
} = await useFetch<EventsResponse>('/api/admin/oauth/events', {
  query: eventsQueryKey,
  watch: [eventsQueryKey],
  default: () => ({ rows: [], total: 0, page: 1, pageSize: eventsPageSize })
})

const eventColor = (eventType: string): 'success' | 'warning' | 'error' | 'info' | 'neutral' => {
  if (eventType.includes('reused') || eventType.includes('denied') || eventType.includes('revoked')) return 'error'
  if (eventType.includes('issued') || eventType.includes('granted') || eventType.includes('rotated')) return 'success'
  if (eventType.includes('reduced') || eventType.includes('aborted')) return 'warning'
  return 'info'
}

const metadataDigest = (m: Record<string, unknown> | null): string => {
  if (!m) return ''
  const parts: string[] = []
  for (const k of ['client_id', 'reason', 'ip', 'family_id'] as const) {
    const v = m[k]
    if (typeof v === 'string' && v) {
      parts.push(`${k}=${k === 'client_id' || k === 'family_id' ? truncate(v, 8, 4) : v}`)
    }
  }
  return parts.join(' · ')
}

const eventColumns: TableColumn<EventRow>[] = [
  {
    accessorKey: 'timestamp',
    header: 'Time',
    cell: ({ row }) => h('span', { class: 'text-sm whitespace-nowrap' },
      formatTimestamp(row.original.timestamp))
  },
  {
    accessorKey: 'event_type',
    header: 'Event',
    cell: ({ row }) => h(UBadge, {
      color: eventColor(row.original.event_type),
      variant: 'subtle',
      size: 'sm'
    }, () => row.original.event_type.replace(/^oauth\./, ''))
  },
  {
    accessorKey: 'user_email',
    header: 'User',
    cell: ({ row }) => h('span', { class: 'text-sm' },
      row.original.user_email ?? (row.original.user_id ? truncate(row.original.user_id, 8, 4) : '—'))
  },
  {
    accessorKey: 'metadata',
    header: 'Details',
    cell: ({ row }) => h('span', { class: 'text-xs text-(--ui-text-muted) font-mono' },
      metadataDigest(row.original.metadata))
  }
]

// ─────────────────────────────────────────────────────────────────────
// Reactive totals (for pagination footers)
// ─────────────────────────────────────────────────────────────────────

const clientsTotal = computed(() => clientsData.value?.total ?? 0)
const familiesTotal = computed(() => familiesData.value?.total ?? 0)
const eventsTotal = computed(() => eventsData.value?.total ?? 0)
const clientsRows = computed(() => clientsData.value?.rows ?? [])
const familiesRows = computed(() => familiesData.value?.rows ?? [])
const eventsRows = computed(() => eventsData.value?.rows ?? [])
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold">OAuth</h1>
        <p class="text-sm text-(--ui-text-muted) mt-1">
          Registered clients, active token families, and recent OAuth audit events.
        </p>
      </div>
    </div>

    <!-- ── Registered Clients ─────────────────────────────────────── -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-xl font-semibold">Registered clients</h2>
            <p class="text-sm text-(--ui-text-muted) mt-1">
              Apps that have registered via Dynamic Client Registration or admin pre-registration.
            </p>
          </div>
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <UInput
              v-model="clientsSearch"
              placeholder="Search name or id..."
              icon="i-lucide-search"
              class="flex-1 sm:w-64"
            />
            <UButton
              icon="i-lucide-refresh-cw"
              variant="ghost"
              color="neutral"
              :loading="clientsPending"
              aria-label="Refresh clients"
              @click="refreshClients()"
            />
          </div>
        </div>
      </template>

      <div class="border border-(--ui-border) rounded-lg overflow-hidden bg-(--ui-bg-elevated)">
        <UTable
          :data="clientsRows"
          :columns="clientColumns"
          :loading="clientsPending"
          :empty-state="{ icon: 'i-lucide-app-window', label: 'No clients registered' }"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 mt-4">
        <p class="text-sm text-(--ui-text-muted)">
          {{ clientsTotal }} total
        </p>
        <UPagination
          v-model:page="clientsPage"
          :total="clientsTotal"
          :items-per-page="clientsPageSize"
        />
      </div>
    </UCard>

    <!-- ── Active Token Families ──────────────────────────────────── -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-xl font-semibold">Active token families</h2>
            <p class="text-sm text-(--ui-text-muted) mt-1">
              Each family is one user × client × authorisation. Revoke kills every token in the family.
            </p>
          </div>
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <UInput
              v-model="familiesSearch"
              placeholder="Search user or client..."
              icon="i-lucide-search"
              class="flex-1 sm:w-64"
            />
            <UButton
              icon="i-lucide-refresh-cw"
              variant="ghost"
              color="neutral"
              :loading="familiesPending"
              aria-label="Refresh families"
              @click="refreshFamilies()"
            />
          </div>
        </div>
      </template>

      <div class="border border-(--ui-border) rounded-lg overflow-hidden bg-(--ui-bg-elevated)">
        <UTable
          :data="familiesRows"
          :columns="familyColumns"
          :loading="familiesPending"
          :empty-state="{ icon: 'i-lucide-key-round', label: 'No active token families' }"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 mt-4">
        <p class="text-sm text-(--ui-text-muted)">
          {{ familiesTotal }} active
        </p>
        <UPagination
          v-model:page="familiesPage"
          :total="familiesTotal"
          :items-per-page="familiesPageSize"
        />
      </div>
    </UCard>

    <!-- ── Recent OAuth Events ────────────────────────────────────── -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-xl font-semibold">Recent events</h2>
            <p class="text-sm text-(--ui-text-muted) mt-1">
              All audit events whose type starts with <code>oauth.</code>
            </p>
          </div>
          <UButton
            icon="i-lucide-refresh-cw"
            variant="ghost"
            color="neutral"
            :loading="eventsPending"
            aria-label="Refresh events"
            @click="refreshEvents()"
          />
        </div>
      </template>

      <div class="border border-(--ui-border) rounded-lg overflow-hidden bg-(--ui-bg-elevated)">
        <UTable
          :data="eventsRows"
          :columns="eventColumns"
          :loading="eventsPending"
          :empty-state="{ icon: 'i-lucide-list', label: 'No OAuth events recorded' }"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 mt-4">
        <p class="text-sm text-(--ui-text-muted)">
          {{ eventsTotal }} events
        </p>
        <UPagination
          v-model:page="eventsPage"
          :total="eventsTotal"
          :items-per-page="eventsPageSize"
        />
      </div>
    </UCard>

    <!-- Family-revoke confirm modal -->
    <UModal v-model:open="revokeFamilyOpen" :dismissible="!revokingFamily">
      <template #content>
        <div class="p-6 space-y-5">
          <div class="flex items-start gap-3">
            <div class="shrink-0 size-10 rounded-full bg-(--ui-error)/10 flex items-center justify-center">
              <UIcon name="i-lucide-triangle-alert" class="size-5 text-(--ui-error)" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-lg font-semibold">Revoke this token family?</h3>
              <p class="text-sm text-(--ui-text-muted) mt-1">
                This kills every access and refresh token in the family. The user's consent
                stays intact, so the client can re-authorise without re-consenting.
              </p>
              <p class="text-xs text-(--ui-text-muted) mt-2 font-mono">
                {{ revokeFamilyTarget?.client_name ?? revokeFamilyTarget?.client_id }} ·
                {{ revokeFamilyTarget?.user_email ?? revokeFamilyTarget?.user_id }}
              </p>
            </div>
          </div>
          <div class="flex items-center justify-end gap-3 pt-2">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="revokingFamily"
              @click="revokeFamilyTarget = null"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              icon="i-lucide-shield-off"
              :loading="revokingFamily"
              @click="handleRevokeFamily"
            >
              Revoke family
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
