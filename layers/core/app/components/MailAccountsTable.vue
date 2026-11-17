<script setup lang="ts">
import type { TableColumn, DropdownMenuItem } from '@nuxt/ui'
import type { MailAccount, MailScope } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  title?: string
}>(), { orgSlug: null, title: 'Accounts' })

const toast = useToast()
const confirmAction = useConfirm()
const { data, pending, error, refresh } = useMailAccounts(props.scope, () => props.orgSlug)
const accounts = computed(() => data.value?.accounts ?? [])
const providers = computed(() => data.value?.providers ?? [])
const base = computed(() => mailApiBase(props.scope, props.orgSlug))

const PROVIDER_ICONS: Record<string, string> = {
  mailgun: 'i-lucide-mail',
  ses: 'i-lucide-cloud',
  sendgrid: 'i-lucide-send'
}

function statusOf(a: MailAccount): { color: string, label: string } {
  if (!a.provider) return { color: 'bg-(--ui-text-dimmed)', label: 'Local only' }
  if (a.capabilities.send === false) return { color: 'bg-(--ui-error)', label: 'Can\'t send' }
  if (Object.values(a.capabilities).includes(false)) return { color: 'bg-(--ui-warning)', label: 'Limited key' }
  if (Object.keys(a.capabilities).length) return { color: 'bg-(--ui-success)', label: 'Working' }
  return { color: 'bg-(--ui-text-dimmed)', label: 'Not tested' }
}

const columns: TableColumn<MailAccount>[] = [
  { id: 'label', header: 'Account' },
  { id: 'provider', header: 'Provider' },
  { id: 'capabilities', header: 'What the key can do' },
  { id: 'status', header: 'Status' },
  { id: 'actions', header: '' }
]

const open = ref(false)
const selected = ref<MailAccount | null>(null)
function openAccount(a: MailAccount | null) {
  selected.value = a
  open.value = true
}

const busy = ref<string | null>(null)

async function verify(a: MailAccount) {
  busy.value = a.id
  try {
    const res = await $fetch<{ verify: { ok: boolean, error?: string } }>(`${base.value}/accounts/${a.id}/verify`, { method: 'POST' })
    if (res.verify.ok) toast.add({ title: 'Key checked', color: 'success' })
    else toast.add({ title: 'The provider refused the key', description: res.verify.error, color: 'error' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Check failed', description: mailErrorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function rotate(a: MailAccount) {
  if (!await confirmAction({
    title: 'Rotate webhook URLs?',
    description: 'The current URLs stop working. Domains set up automatically get the new ones; anywhere you pasted them by hand needs the new URLs.',
    confirmLabel: 'Rotate'
  })) return
  busy.value = a.id
  try {
    await $fetch(`${base.value}/accounts/${a.id}/rotate-webhooks`, { method: 'POST' })
    toast.add({ title: 'Webhook URLs rotated', color: 'success' })
    await refreshMail(props.scope, 'accounts', 'domains')
  } catch (err) {
    toast.add({ title: 'Rotation failed', description: mailErrorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function remove(a: MailAccount) {
  if (!await confirmAction({ title: `Delete ${a.label}?`, confirmLabel: 'Delete account' })) return
  busy.value = a.id
  try {
    await $fetch(`${base.value}/accounts/${a.id}`, { method: 'DELETE' })
    toast.add({ title: 'Account deleted', color: 'success' })
    await refresh()
  } catch (err) {
    toast.add({ title: 'Delete failed', description: mailErrorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

function menu(a: MailAccount): DropdownMenuItem[][] {
  const main: DropdownMenuItem[] = []
  if (a.provider) main.push({ label: 'Check the key', icon: 'i-lucide-shield-check', onSelect: () => verify(a) })
  if (a.provider && a.webhookUrls) main.push({ label: 'Rotate webhook URLs', icon: 'i-lucide-refresh-cw', onSelect: () => rotate(a) })
  const groups = [main]
  if (a.source !== 'env') groups.push([{ label: 'Delete', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => remove(a) }])
  return groups.filter(g => g.length)
}
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
      :title="mailErrorMessage(error, 'Accounts didn\'t load')"
      :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { refresh() } }]"
    />
    <p
      v-else-if="!pending && accounts.length === 0"
      class="p-4 text-sm text-(--ui-text-muted)"
    >
      <template v-if="scope === 'host'">
        Mail isn't configured. Add an account to send password resets and invites.
      </template>
      <template v-else>
        No accounts of your own. Your domains use the host's provider.
      </template>
    </p>
    <UTable
      v-else
      :data="accounts"
      :columns="columns"
      :loading="pending && accounts.length === 0"
      :ui="{ tr: 'cursor-pointer' }"
      @select="(_e: Event, row: { original: MailAccount }) => openAccount(row.original)"
    >
      <template #label-cell="{ row }">
        <div class="flex items-center gap-2 font-medium">
          {{ row.original.label }}
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
      </template>
      <template #provider-cell="{ row }">
        <div
          v-if="row.original.provider"
          class="flex items-center gap-2"
        >
          <UIcon
            :name="PROVIDER_ICONS[row.original.provider] ?? 'i-lucide-server'"
            class="size-4"
          />
          {{ row.original.providerLabel ?? row.original.provider }}
        </div>
        <div
          v-else
          class="flex items-center gap-2 text-(--ui-text-muted)"
        >
          <UIcon
            name="i-lucide-mail-x"
            class="size-4 text-(--ui-text-dimmed)"
          />
          None (local and log only)
        </div>
      </template>
      <template #capabilities-cell="{ row }">
        <MailCapabilityBadges
          v-if="row.original.provider"
          :capabilities="row.original.capabilities"
        />
      </template>
      <template #status-cell="{ row }">
        <span class="flex items-center gap-2 text-sm whitespace-nowrap">
          <span
            class="size-2 rounded-full"
            :class="statusOf(row.original).color"
          />
          {{ statusOf(row.original).label }}
        </span>
      </template>
      <template #actions-cell="{ row }">
        <div
          class="flex justify-end"
          @click.stop
        >
          <UDropdownMenu
            v-if="menu(row.original).length"
            :items="menu(row.original)"
          >
            <UButton
              icon="i-lucide-ellipsis"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Account actions"
              :loading="busy === row.original.id"
            />
          </UDropdownMenu>
        </div>
      </template>
    </UTable>

    <template #footer>
      <UButton
        icon="i-lucide-plus"
        :disabled="!providers.length"
        @click="openAccount(null)"
      >
        Add account
      </UButton>
    </template>

    <MailAccountSlideover
      v-model:open="open"
      :scope="scope"
      :org-slug="orgSlug"
      :account="selected"
      :providers="providers"
      @saved="(a: MailAccount) => { selected = a }"
    />
  </UCard>
</template>
