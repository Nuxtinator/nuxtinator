<script setup lang="ts">
// Adds a domain in one step: provider, domain, its key, and whether it
// receives. A key that belongs to the domain (a Mailgun sending key) is saved
// on the domain; what the provider account shares across domains (a signing
// key, the region) is saved once as an account and reused by the next domain.
// The domain is saved for setup by hand and checked at once; its panel then
// shows what is still missing at the provider.
import type { MailAccount, MailCredentialField, MailDomainCheck, MailDomainResponse, MailDomainSetup, MailProviderInfo, MailScope } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
}>(), { orgSlug: null })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ added: [res: MailDomainResponse] }>()

const toast = useToast()
const { data: accountsData } = useMailAccounts(props.scope, () => props.orgSlug)
const { data: streamsData } = useMailStreams(props.scope, () => props.orgSlug)
const accounts = computed(() => accountsData.value?.accounts ?? [])
const providers = computed(() => (accountsData.value?.providers ?? []).filter(p => p.supports.send))
// The check results the domain's panel shows, keyed by domain id.
const results = useState<Record<string, { setup?: MailDomainSetup | null, check?: MailDomainCheck | null }>>('mail-domain-results', () => ({}))

const HOST = 'host'
const LOCAL = 'local'
const NEW_ACCOUNT = 'new'
const localAccount = computed(() => props.scope === 'host' ? accounts.value.find(a => !a.provider) ?? null : null)
const providerItems = computed(() => [
  ...(props.scope === 'org' ? [{ value: HOST, label: 'Through the host', icon: 'i-lucide-server' }] : []),
  ...providers.value.map(p => ({ value: p.id, label: p.label, icon: 'i-lucide-mail' })),
  ...(localAccount.value ? [{ value: LOCAL, label: 'No provider', icon: 'i-lucide-terminal' }] : [])
])

const providerId = ref<string>('')
const domain = ref('')
const accountChoice = ref<string>(NEW_ACCOUNT)
const accountValues = ref<Record<string, string>>({})
const domainKeyValues = ref<Record<string, string>>({})
const dkimSelector = ref('')
const receive = ref(false)
const makeDefault = ref(false)
const moreOpen = ref(false)
const saving = ref(false)
const keyError = ref<string | null>(null)

const provider = computed<MailProviderInfo | null>(() => providers.value.find(p => p.id === providerId.value) ?? null)
const savedAccounts = computed<MailAccount[]>(() => provider.value ? accounts.value.filter(a => a.provider === provider.value!.id) : [])
const accountItems = computed(() => [
  ...savedAccounts.value.map(a => ({ value: a.id, label: a.source === 'env' ? `${a.label} (environment)` : a.label })),
  { value: NEW_ACCOUNT, label: `Another ${provider.value?.label ?? ''} account` }
])
const newAccount = computed(() => !!provider.value && accountChoice.value === NEW_ACCOUNT)
const domainFields = computed<MailCredentialField[]>(() => provider.value?.domainCredentialFields ?? [])
const accountFields = computed(() => (provider.value?.credentialFields ?? []).filter(f => !f.advanced))
const advancedFields = computed(() => (provider.value?.credentialFields ?? []).filter(f => f.advanced))
const canReceive = computed(() => providerId.value === HOST || !!provider.value?.supports.receive)

watch(open, (v) => {
  if (!v) return
  providerId.value = String(providerItems.value[0]?.value ?? '')
  domain.value = ''
  accountValues.value = {}
  domainKeyValues.value = {}
  dkimSelector.value = ''
  receive.value = false
  moreOpen.value = false
  keyError.value = null
  makeDefault.value = props.scope === 'host' && !accounts.value.some(a => a.source === 'env') && !streamsData.value?.defaultDomainId
}, { immediate: true })
watch(providerId, () => {
  accountChoice.value = String(accountItems.value[0]?.value ?? NEW_ACCOUNT)
  accountValues.value = {}
  domainKeyValues.value = {}
  keyError.value = null
  if (!canReceive.value) receive.value = false
})

const base = computed(() => mailApiBase(props.scope, props.orgSlug))
const trimmed = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))

// A new account is named after the provider; one the provider refuses is removed again.
async function accountId(): Promise<{ id: string | null, created: boolean } | null> {
  if (providerId.value === HOST) return { id: null, created: false }
  if (providerId.value === LOCAL) return { id: localAccount.value?.id ?? null, created: false }
  if (!newAccount.value) return { id: accountChoice.value, created: false }
  const label = savedAccounts.value.length ? `${provider.value!.label} ${savedAccounts.value.length + 1}` : provider.value!.label
  const res = await $fetch<{ account: MailAccount, verify: { ok: boolean, error?: string } | null }>(`${base.value}/accounts`, {
    method: 'POST',
    body: { provider: providerId.value, label, credentials: trimmed(accountValues.value) }
  })
  if (res.verify && !res.verify.ok) {
    keyError.value = res.verify.error ?? `${provider.value!.label} didn't accept the key`
    await $fetch(`${base.value}/accounts/${res.account.id}`, { method: 'DELETE' }).catch(() => {})
    return null
  }
  return { id: res.account.id, created: true }
}

async function submit() {
  if (!domain.value.trim()) return
  saving.value = true
  keyError.value = null
  let createdAccount: string | null = null
  let createdDomain: string | null = null
  try {
    const account = await accountId()
    if (!account) return
    if (account.created) createdAccount = account.id
    const body: Record<string, unknown> = { domain: domain.value.trim() }
    if (providerId.value === HOST) {
      body.receive = receive.value
    } else {
      body.sendAccountId = account.id
      body.receiveAccountId = receive.value ? account.id : null
      body.setupMode = 'manual'
      const creds = trimmed(domainKeyValues.value)
      if (Object.keys(creds).length) body.credentials = creds
      if (dkimSelector.value.trim()) body.dkimSelector = dkimSelector.value.trim()
    }
    if (props.scope === 'host') body.makeDefault = makeDefault.value
    const res = await $fetch<MailDomainResponse>(`${base.value}/domains`, { method: 'POST', body })
    createdDomain = res.domain.id
    // The domain's own key is tried against the provider when the domain is added.
    if (res.domain.ownershipStatus === 'verified' && res.domain.hasOwnCredentials && res.domain.capabilities.send === false) {
      keyError.value = `${provider.value?.label ?? 'The provider'} didn't accept the ${domainFields.value[0]?.label.toLowerCase() ?? 'key'} for ${res.domain.domain}`
      return
    }
    createdAccount = null
    createdDomain = null
    if (res.domain.ownershipStatus === 'verified') {
      const checked = await $fetch<MailDomainResponse>(`${base.value}/domains/${res.domain.id}/check`, { method: 'POST' }).catch(() => null)
      results.value = { ...results.value, [res.domain.id]: { setup: res.setup ?? null, check: checked?.check ?? null } }
    }
    await refreshMail(props.scope, 'domains', 'streams', 'accounts')
    toast.add({ title: `${res.domain.domain} added`, color: 'success' })
    open.value = false
    emit('added', res)
  } catch (err) {
    toast.add({ title: 'Domain not added', description: mailErrorMessage(err), color: 'error' })
  } finally {
    if (createdDomain) await $fetch(`${base.value}/domains/${createdDomain}`, { method: 'DELETE' }).catch(() => {})
    if (createdAccount) await $fetch(`${base.value}/accounts/${createdAccount}`, { method: 'DELETE' }).catch(() => {})
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Add domain"
    :ui="{ content: 'sm:max-w-lg' }"
  >
    <template #body>
      <form
        id="mail-add-domain-form"
        class="space-y-5"
        @submit.prevent="submit"
      >
        <URadioGroup
          v-model="providerId"
          :items="providerItems"
          variant="card"
          indicator="hidden"
          orientation="horizontal"
          legend="Provider"
        />

        <UFormField
          label="Domain"
          required
        >
          <UInput
            v-model="domain"
            placeholder="mail.example.org"
            autofocus
            class="w-full"
          />
        </UFormField>

        <template v-if="provider">
          <UFormField
            v-for="field in domainFields"
            :key="field.key"
          >
            <template #label>
              {{ field.label }} <InfoTip
                v-if="field.help"
                :text="field.help"
              />
            </template>
            <UInput
              v-model="domainKeyValues[field.key]"
              :type="field.secret ? 'password' : 'text'"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="savedAccounts.length"
            :label="`${provider.label} account`"
          >
            <USelect
              v-model="accountChoice"
              :items="accountItems"
              class="w-full"
            />
          </UFormField>
          <template v-if="newAccount">
            <UFormField
              v-for="field in accountFields"
              :key="field.key"
              :required="!field.optional"
            >
              <template #label>
                {{ field.label }} <InfoTip
                  v-if="field.help"
                  :text="field.help"
                />
              </template>
              <UInput
                v-model="accountValues[field.key]"
                :type="field.secret ? 'password' : 'text'"
                autocomplete="off"
                :placeholder="field.optional ? 'Optional' : undefined"
                class="w-full"
              />
            </UFormField>
          </template>
          <p
            v-if="keyError"
            class="text-sm text-(--ui-error)"
          >
            {{ keyError }}
          </p>
        </template>

        <USwitch
          v-if="canReceive"
          v-model="receive"
        >
          <template #label>
            Receive email on this domain <InfoTip
              v-if="provider?.notes.receive"
              :text="provider.notes.receive"
            />
          </template>
        </USwitch>

        <UCheckbox
          v-if="scope === 'host'"
          v-model="makeDefault"
          label="Make this the default domain"
        />

        <template v-if="provider">
          <UButton
            variant="link"
            color="neutral"
            class="p-0"
            :trailing-icon="moreOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            @click="moreOpen = !moreOpen"
          >
            More options
          </UButton>
          <template v-if="moreOpen">
            <template v-if="newAccount">
              <UFormField
                v-for="field in advancedFields"
                :key="field.key"
              >
                <template #label>
                  {{ field.label }} <InfoTip
                    v-if="field.help"
                    :text="field.help"
                  />
                </template>
                <UInput
                  v-model="accountValues[field.key]"
                  :type="field.secret ? 'password' : 'text'"
                  autocomplete="off"
                  placeholder="Optional"
                  class="w-full"
                />
              </UFormField>
            </template>
            <UFormField>
              <template #label>
                DKIM selector <InfoTip text="The name before ._domainkey in the provider's DKIM record, so the check can find it." />
              </template>
              <UInput
                v-model="dkimSelector"
                placeholder="Optional"
                class="w-full"
              />
            </UFormField>
          </template>
        </template>
      </form>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          variant="ghost"
          color="neutral"
          @click="open = false"
        >
          Cancel
        </UButton>
        <UButton
          type="submit"
          form="mail-add-domain-form"
          :loading="saving"
          :disabled="!domain.trim() || !providerId"
        >
          Next
        </UButton>
      </div>
    </template>
  </UModal>
</template>
