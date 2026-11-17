<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { MailScope, MailSuppression } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  title?: string
}>(), { orgSlug: null, title: 'Suppressions' })

const toast = useToast()
const confirmAction = useConfirm()

const reason = ref<MailSuppression['reason'] | undefined>(undefined)
const addressInput = ref('')
const address = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
watch(addressInput, (v) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    address.value = v.trim()
  }, 300)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const { data, pending, error, refresh } = useAsyncData<{ suppressions: MailSuppression[] }>(
  mailDataKey(props.scope, 'suppressions'),
  () => $fetch<{ suppressions: MailSuppression[] }>(`${mailApiBase(props.scope, props.orgSlug)}/suppressions`, {
    query: { reason: reason.value, address: address.value || undefined }
  }),
  { default: () => ({ suppressions: [] }), watch: [reason, address, () => props.orgSlug] }
)
const rows = computed(() => data.value?.suppressions ?? [])

const { data: domainsData } = useMailDomains(props.scope, () => props.orgSlug)
const unmanaged = computed(() => (domainsData.value?.domains ?? []).filter(d => d.suppressionMode === 'unmanaged' && d.ownershipStatus === 'verified').map(d => d.domain))

const reasonItems = Object.entries(MAIL_SUPPRESSION_REASONS).map(([value, label]) => ({ value, label }))

const columns = computed<TableColumn<MailSuppression>[]>(() => [
  ...(address.value ? [{ id: 'address', header: 'Address' }] : []),
  { id: 'reason', header: 'Reason' },
  { id: 'scope', header: 'Applies to' },
  { id: 'source', header: 'Source' },
  { id: 'date', header: 'Date' },
  { id: 'actions', header: '' }
])

const clearing = ref<string | null>(null)
async function clear(row: MailSuppression) {
  if (!await confirmAction({
    title: 'Clear this suppression?',
    description: 'Mail to this address is sent again. A later bounce or complaint suppresses it again.',
    confirmLabel: 'Clear'
  })) return
  clearing.value = row.id
  try {
    await $fetch(`${mailApiBase(props.scope, props.orgSlug)}/suppressions/${row.id}/clear`, {
      method: 'POST',
      body: address.value ? { address: address.value } : {}
    })
    toast.add({ title: 'Suppression cleared', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Not cleared', description: mailErrorMessage(err), color: 'error' })
  } finally {
    clearing.value = null
  }
}

// An org can't clear a suppression that applies everywhere.
const canClear = (row: MailSuppression) => props.scope === 'host' || row.scope === 'org'
</script>

<template>
  <div class="space-y-4">
    <UAlert
      v-if="unmanaged.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-list-x"
      title="Provider suppression list active"
      :description="`Clearing here won't unblock sends on ${unmanaged.join(', ')}.`"
    />
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold flex items-center gap-1 mr-auto">
            {{ title }}
            <InfoTip text="Addresses aren't stored, only a fingerprint of each. Search for an address to see its rows." />
          </h2>
          <UInput
            v-model="addressInput"
            icon="i-lucide-search"
            placeholder="Search an address"
            type="email"
            class="w-full sm:w-64"
            aria-label="Search an address"
          />
          <div class="flex items-center gap-1">
            <USelect
              v-model="reason"
              :items="reasonItems"
              placeholder="All reasons"
              class="w-40"
              aria-label="Reason"
            />
            <UButton
              v-if="reason"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              aria-label="Show all reasons"
              @click="reason = undefined"
            />
          </div>
        </div>
      </template>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        class="m-4"
        :title="mailErrorMessage(error, 'Suppressions didn\'t load')"
        :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { refresh() } }]"
      />
      <p
        v-else-if="!pending && rows.length === 0"
        class="p-4 text-sm text-(--ui-text-muted)"
      >
        {{ address ? 'Nothing is suppressed for that address.' : 'No suppressed addresses.' }}
      </p>
      <UTable
        v-else
        :data="rows"
        :columns="columns"
        :loading="pending"
      >
        <template #address-cell="{ row }">
          <span class="font-medium">{{ row.original.address }}</span>
        </template>
        <template #reason-cell="{ row }">
          <UBadge
            :color="row.original.reason === 'complaint' ? 'warning' : 'error'"
            variant="subtle"
            size="sm"
          >
            {{ MAIL_SUPPRESSION_REASONS[row.original.reason] }}
          </UBadge>
        </template>
        <template #scope-cell="{ row }">
          {{ MAIL_SUPPRESSION_SCOPES[row.original.scope] }}
        </template>
        <template #source-cell="{ row }">
          <div class="min-w-0">
            <div>{{ row.original.source ?? '—' }}</div>
            <div
              v-if="row.original.detail"
              class="text-xs text-(--ui-text-muted) truncate max-w-xs"
              :title="row.original.detail"
            >
              {{ row.original.detail }}
            </div>
          </div>
        </template>
        <template #date-cell="{ row }">
          <span class="whitespace-nowrap">{{ formatMailDate(row.original.occurredAt) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UButton
              v-if="canClear(row.original)"
              size="sm"
              variant="outline"
              color="neutral"
              :loading="clearing === row.original.id"
              @click="clear(row.original)"
            >
              Clear
            </UButton>
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
