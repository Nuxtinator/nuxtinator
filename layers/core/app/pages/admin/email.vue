<script setup lang="ts">
import type { MailSendResult } from '#core/app/composables/useMailAdmin'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const route = useRoute()
const toast = useToast()
const { user } = useAuth()
const tenancyEnabled = computed(() => useRuntimeConfig().public.tenancy === true)

const TABS = [
  { label: 'Accounts', value: 'accounts', icon: 'i-lucide-key-round' },
  { label: 'Domains', value: 'domains', icon: 'i-lucide-globe' },
  { label: 'Streams', value: 'streams', icon: 'i-lucide-git-fork' },
  { label: 'Suppressions', value: 'suppressions', icon: 'i-lucide-ban' }
]
const tab = computed({
  get: () => TABS.some(t => t.value === route.query.tab) ? route.query.tab as string : 'accounts',
  set: (v: string | number) => navigateTo({ query: { ...route.query, tab: v === 'accounts' ? undefined : String(v) } }, { replace: true })
})

const { data: accountsData } = useMailAccounts('host')
const { data: streamsData } = useMailStreams('host')
const accounts = computed(() => accountsData.value?.accounts ?? [])
const copy = useMailCopy()

// Which host accounts organizations' own domains are set up on.
const { data: orgAccounts, refresh: refreshOrgAccounts } = useAsyncData<{ sendAccountId: string | null, receiveAccountId: string | null }>(
  'mail-org-accounts',
  () => tenancyEnabled.value ? $fetch('/api/admin/mail/org-accounts') : Promise.resolve({ sendAccountId: null, receiveAccountId: null })
)
const providerOf = (id: string | null) => accountsData.value?.providers.find(p => p.id === id) ?? null
const orgSendItems = computed(() => accounts.value.filter(a => a.source === 'ui' && providerOf(a.provider)?.supports.send).map(a => ({ label: a.label, value: a.id })))
const orgReceiveItems = computed(() => accounts.value.filter(a => a.source === 'ui' && providerOf(a.provider)?.supports.receive).map(a => ({ label: a.label, value: a.id })))
type OrgAccountField = 'sendAccountId' | 'receiveAccountId'
const orgSendRow = useSettingsRow('mail-org-send-account')
const orgReceiveRow = useSettingsRow('mail-org-receive-account')
const orgAccountRows = computed(() => [
  { field: 'sendAccountId' as const, label: 'Sending', items: orgSendItems.value, row: orgSendRow },
  { field: 'receiveAccountId' as const, label: 'Receiving', items: orgReceiveItems.value, row: orgReceiveRow }
])
const accountLabel = (id: string | null | undefined) => id ? (accounts.value.find(a => a.id === id)?.label ?? 'Unknown account') : 'Environment account'
const orgAccountDraft = ref<string | undefined>(undefined)
function changeOrgAccount(field: OrgAccountField, row: ReturnType<typeof useSettingsRow>) {
  orgAccountDraft.value = orgAccounts.value?.[field] ?? undefined
  row.toggle()
}
const savingOrgAccounts = ref(false)
async function setOrgAccount(field: OrgAccountField, value: string | null, row: ReturnType<typeof useSettingsRow>) {
  savingOrgAccounts.value = true
  try {
    await $fetch('/api/admin/mail/org-accounts', { method: 'PUT', body: { [field]: value } })
    toast.add({ title: 'Saved', color: 'success' })
    row.close()
  } catch (err) {
    toast.add({ title: 'Not saved', description: mailErrorMessage(err), color: 'error' })
  } finally {
    savingOrgAccounts.value = false
    await refreshOrgAccounts()
  }
}

const testOpen = ref(false)
const testStream = ref<string | undefined>(undefined)
const testTo = ref('')
const testSending = ref(false)
const testResult = ref<MailSendResult | null>(null)
const streamItems = computed(() => (streamsData.value?.streams ?? []).map(s => ({ label: s.label, value: s.id })))
function openTest() {
  testStream.value ??= streamItems.value.find(s => s.value === 'system')?.value ?? streamItems.value[0]?.value
  testTo.value ||= user.value?.email ?? ''
  testResult.value = null
  testOpen.value = true
}
async function sendTest() {
  if (!testStream.value || !testTo.value.trim()) return
  testSending.value = true
  testResult.value = null
  try {
    const res = await $fetch<{ result: MailSendResult }>('/api/admin/mail/test', { method: 'POST', body: { stream: testStream.value, to: testTo.value.trim() } })
    testResult.value = res.result
  } catch (err) {
    testResult.value = { status: 'failed', retryable: false, error: mailErrorMessage(err) }
  } finally {
    testSending.value = false
  }
}
const testSummary = computed(() => {
  const r = testResult.value
  if (!r) return null
  switch (r.status) {
    case 'sent': return { color: 'success' as const, title: `Sent from ${r.domain}`, description: r.messageId ?? undefined }
    case 'queued': return { color: 'success' as const, title: 'Queued', description: 'It goes out on the next outbox pass.' }
    case 'suppressed': return { color: 'warning' as const, title: 'Not sent: the address is suppressed', description: MAIL_SUPPRESSION_REASONS[r.reason] }
    case 'refused': return { color: 'warning' as const, title: `Refused by ${r.guard}`, description: r.reason }
    case 'no_sender': return { color: 'error' as const, title: 'No domain can send this stream', description: `Pick a domain for ${r.stream} under Streams.` }
    case 'failed': return { color: 'error' as const, title: r.retryable ? 'Failed (would be retried)' : 'Failed', description: r.error }
    default: return { color: 'error' as const, title: 'Unknown outcome', description: r.error }
  }
})
</script>

<template>
  <div class="space-y-4">
    <header class="flex items-center justify-between gap-2">
      <h1 class="text-2xl font-bold">
        Email
      </h1>
      <UButton
        icon="i-lucide-send"
        variant="outline"
        color="neutral"
        @click="openTest"
      >
        Send test
      </UButton>
    </header>

    <UTabs
      v-model="tab"
      :items="TABS"
      :content="false"
      variant="link"
      activation-mode="manual"
    />

    <div
      v-if="tab === 'accounts'"
      class="space-y-4"
    >
      <MailAccountsTable scope="host" />

      <UCard v-if="accountsData?.outboxPublicKey">
        <template #header>
          <h2 class="text-lg font-semibold flex items-center gap-1">
            Keys for other processes
            <InfoTip text="A process that only queues mail (a public server, a worker without the secret key) needs this outbox public key." />
          </h2>
        </template>
        <div class="flex items-center gap-2">
          <code class="font-mono text-xs truncate flex-1">{{ accountsData.outboxPublicKey }}</code>
          <UButton
            icon="i-lucide-copy"
            color="neutral"
            variant="outline"
            size="sm"
            @click="copy(accountsData.outboxPublicKey, 'Outbox public key copied')"
          >
            Copy
          </UButton>
        </div>
      </UCard>

      <UCard v-if="tenancyEnabled && orgAccounts">
        <template #header>
          <h2 class="text-lg font-semibold flex items-center gap-1">
            Accounts for organizations' domains
            <InfoTip text="When an organization adds its own domain, it is set up on these accounts unless the organization adds an account of its own." />
          </h2>
        </template>
        <div class="divide-y divide-(--ui-border)">
          <SettingsRow
            v-for="r in orgAccountRows"
            :key="r.field"
            :label="r.label"
            :value="accountLabel(orgAccounts[r.field])"
            :open="r.row.open.value"
          >
            <template #actions>
              <UButton
                variant="outline"
                color="neutral"
                size="sm"
                :disabled="!r.items.length"
                @click="changeOrgAccount(r.field, r.row)"
              >
                Change
              </UButton>
            </template>
            <template #panel>
              <form
                class="flex flex-col sm:flex-row sm:items-center gap-2"
                @submit.prevent="setOrgAccount(r.field, orgAccountDraft ?? null, r.row)"
              >
                <div class="flex items-center gap-1 w-full sm:w-72">
                  <USelect
                    v-model="orgAccountDraft"
                    :items="r.items"
                    placeholder="Environment account"
                    class="flex-1"
                    :aria-label="`${r.label} account`"
                  />
                  <UButton
                    v-if="orgAccountDraft"
                    icon="i-lucide-x"
                    color="neutral"
                    variant="ghost"
                    aria-label="Use the environment account"
                    @click="orgAccountDraft = undefined"
                  />
                </div>
                <div class="flex gap-2">
                  <UButton
                    type="submit"
                    size="sm"
                    :loading="savingOrgAccounts"
                  >
                    Save
                  </UButton>
                  <UButton
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    @click="r.row.close()"
                  >
                    Cancel
                  </UButton>
                </div>
              </form>
            </template>
          </SettingsRow>
        </div>
      </UCard>
    </div>

    <MailDomainsTable
      v-else-if="tab === 'domains'"
      scope="host"
    />
    <MailStreamsTable
      v-else-if="tab === 'streams'"
      scope="host"
    />
    <MailSuppressionsTable
      v-else
      scope="host"
    />

    <UModal
      v-model:open="testOpen"
      title="Send a test email"
    >
      <template #body>
        <form
          id="mail-test-form"
          class="space-y-5"
          @submit.prevent="sendTest"
        >
          <UFormField label="Stream">
            <USelect
              v-model="testStream"
              :items="streamItems"
              placeholder="Choose a stream"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Send to">
            <UInput
              v-model="testTo"
              type="email"
              class="w-full"
            />
          </UFormField>
          <UAlert
            v-if="testSummary"
            :color="testSummary.color"
            variant="subtle"
            :title="testSummary.title"
            :description="testSummary.description"
          />
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            variant="ghost"
            color="neutral"
            @click="testOpen = false"
          >
            Close
          </UButton>
          <UButton
            type="submit"
            form="mail-test-form"
            icon="i-lucide-send"
            :loading="testSending"
            :disabled="!testStream || !testTo.trim()"
          >
            Send
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
