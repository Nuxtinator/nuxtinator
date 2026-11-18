<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { MailDomain, MailDomainResponse, MailDomainSetup, MailRoleStatus, MailScope } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  title?: string
}>(), { orgSlug: null, title: 'Domains' })

const { data, pending, error, refresh } = useMailDomains(props.scope, () => props.orgSlug)
const domains = computed(() => data.value?.domains ?? [])

const columns: TableColumn<MailDomain>[] = [
  { id: 'domain', header: 'Domain' },
  { id: 'send', header: 'Sending' },
  { id: 'receive', header: 'Receiving' },
  { id: 'webhooks', header: 'Webhooks' }
]

const addOpen = ref(false)
const detailOpen = ref(false)
const selectedId = ref<string | null>(null)
const setup = ref<MailDomainSetup | null>(null)

function openDomain(id: string, s: MailDomainSetup | null = null) {
  selectedId.value = id
  setup.value = s
  detailOpen.value = true
}
function onAdded(res: MailDomainResponse) {
  openDomain(res.domain.id, res.setup ?? null)
}

const status = (s: MailRoleStatus) => MAIL_ROLE_STATUS[s]
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <h2 class="text-lg font-semibold">
        {{ title }}
      </h2>
    </template>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      class="m-4"
      :title="mailErrorMessage(error, 'Domains didn\'t load')"
      :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { refresh() } }]"
    />
    <p
      v-else-if="!pending && domains.length === 0"
      class="p-4 text-sm text-(--ui-text-muted)"
    >
      <template v-if="scope === 'host'">
        Mail isn't configured. Add a domain to send password resets and invites.
      </template>
      <template v-else>
        Add a domain to send or receive mail on it.
      </template>
    </p>
    <UTable
      v-else
      :data="domains"
      :columns="columns"
      :loading="pending && domains.length === 0"
      :ui="{ tr: 'cursor-pointer' }"
      @select="(_e: Event, row: { original: MailDomain }) => openDomain(row.original.id)"
    >
      <template #domain-cell="{ row }">
        <div class="space-y-1">
          <div class="font-medium flex items-center gap-2">
            {{ row.original.domain }}
            <UBadge
              v-if="row.original.source === 'env'"
              color="neutral"
              variant="subtle"
              size="sm"
              leading-icon="i-lucide-lock"
            >
              Read-only
            </UBadge>
          </div>
          <div class="flex flex-wrap gap-1">
            <UBadge
              v-if="row.original.ownershipStatus === 'pending'"
              color="warning"
              variant="subtle"
              size="sm"
            >
              Ownership not confirmed
            </UBadge>
            <UBadge
              v-if="row.original.ownershipStatus === 'lapsed'"
              color="error"
              variant="subtle"
              size="sm"
            >
              Ownership lapsed
            </UBadge>
            <UBadge
              v-if="row.original.sendError === 'key_rejected'"
              color="error"
              variant="subtle"
              size="sm"
              leading-icon="i-lucide-key-round"
            >
              Key rejected
            </UBadge>
          </div>
        </div>
      </template>
      <template #send-cell="{ row }">
        <div
          v-if="row.original.sendAccountId"
          class="flex items-center gap-2 whitespace-nowrap"
        >
          <span class="text-sm">{{ row.original.sendProvider?.label }}</span>
          <UBadge
            :color="status(row.original.sendStatus).color"
            variant="subtle"
            size="sm"
          >
            {{ status(row.original.sendStatus).label }}
          </UBadge>
        </div>
        <span
          v-else
          class="text-sm text-(--ui-text-dimmed)"
        >—</span>
      </template>
      <template #receive-cell="{ row }">
        <div
          v-if="row.original.receiveAccountId"
          class="flex items-center gap-2 whitespace-nowrap"
        >
          <span class="text-sm">{{ row.original.receiveProvider?.label }}</span>
          <UBadge
            :color="status(row.original.receiveStatus).color"
            variant="subtle"
            size="sm"
          >
            {{ status(row.original.receiveStatus).label }}
          </UBadge>
        </div>
        <span
          v-else
          class="text-sm text-(--ui-text-dimmed)"
        >—</span>
      </template>
      <template #webhooks-cell="{ row }">
        <UBadge
          :color="MAIL_WEBHOOK_STATES[row.original.webhooks.state].color"
          variant="subtle"
          size="sm"
        >
          {{ MAIL_WEBHOOK_STATES[row.original.webhooks.state].label }}
        </UBadge>
      </template>
    </UTable>

    <template #footer>
      <UButton
        icon="i-lucide-plus"
        @click="addOpen = true"
      >
        Add domain
      </UButton>
    </template>

    <MailAddDomainModal
      v-model:open="addOpen"
      :scope="scope"
      :org-slug="orgSlug"
      @added="onAdded"
    />
    <MailDomainSlideover
      v-model:open="detailOpen"
      :scope="scope"
      :org-slug="orgSlug"
      :domain-id="selectedId"
      :setup="setup"
    />
  </UCard>
</template>
