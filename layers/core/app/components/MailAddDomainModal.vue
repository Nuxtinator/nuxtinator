<script setup lang="ts">
import type { MailDomainResponse, MailScope } from '#core/app/composables/useMailAdmin'

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
const providers = computed(() => accountsData.value?.providers ?? [])
const providerOf = (accountId?: string) => {
  const a = accounts.value.find(x => x.id === accountId)
  return a?.provider ? providers.value.find(p => p.id === a.provider) ?? null : null
}

const envAccount = computed(() => accounts.value.find(a => a.source === 'env') ?? null)
const sendItems = computed(() => accounts.value
  .filter(a => !a.provider || providerOf(a.id)?.supports.send)
  .map(a => ({ label: a.provider ? a.label : `${a.label} (local and log only)`, value: a.id })))
const receiveItems = computed(() => accounts.value
  .filter(a => providerOf(a.id)?.supports.receive)
  .map(a => ({ label: a.label, value: a.id })))

const domain = ref('')
const sendAccountId = ref<string | undefined>(undefined)
const receiveAccountId = ref<string | undefined>(undefined)
const setupMode = ref<'auto' | 'manual'>('auto')
const dkimSelector = ref('')
const keyValues = ref<Record<string, string>>({})
const makeDefault = ref(false)
const saving = ref(false)

watch(open, (v) => {
  if (!v) return
  domain.value = ''
  sendAccountId.value = props.scope === 'host' ? (envAccount.value?.id ?? sendItems.value[0]?.value) : undefined
  receiveAccountId.value = undefined
  setupMode.value = 'auto'
  dkimSelector.value = ''
  keyValues.value = {}
  makeDefault.value = props.scope === 'host' && !envAccount.value && !streamsData.value?.defaultDomainId
}, { immediate: true })

const chosenSend = computed(() => accounts.value.find(a => a.id === sendAccountId.value) ?? null)
const sendProvider = computed(() => providerOf(sendAccountId.value))
// Automatic setup needs a provider whose key hasn't been refused domain management.
const autoAvailable = computed(() => {
  if (props.scope === 'org' && !sendAccountId.value) return true
  return !!chosenSend.value?.provider && chosenSend.value.capabilities.domains !== false
})
watch(autoAvailable, (v) => {
  if (!v) setupMode.value = 'manual'
})

const modeItems = computed(() => [
  { value: 'auto', label: 'Set it up for me', description: 'Registers the domain at the provider and lists the DNS records to add.', icon: 'i-lucide-wand-sparkles', disabled: !autoAvailable.value },
  { value: 'manual', label: 'I\'ll set it up myself at the provider', description: 'Nothing is changed at the provider. You get the steps.', icon: 'i-lucide-list-checks' }
])

async function submit() {
  if (!domain.value.trim()) return
  saving.value = true
  try {
    const body: Record<string, unknown> = { domain: domain.value.trim(), setupMode: setupMode.value }
    if (props.scope === 'host') {
      body.sendAccountId = sendAccountId.value ?? null
      body.receiveAccountId = receiveAccountId.value ?? null
      body.makeDefault = makeDefault.value
    } else if (sendAccountId.value) {
      body.sendAccountId = sendAccountId.value
      body.receiveAccountId = sendProvider.value?.supports.receive ? sendAccountId.value : null
    }
    if (setupMode.value === 'manual') {
      const creds = Object.fromEntries(Object.entries(keyValues.value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
      if (Object.keys(creds).length) body.credentials = creds
      if (dkimSelector.value.trim()) body.dkimSelector = dkimSelector.value.trim()
    }
    const res = await $fetch<MailDomainResponse>(`${mailApiBase(props.scope, props.orgSlug)}/domains`, { method: 'POST', body })
    await refreshMail(props.scope, 'domains', 'streams', 'accounts')
    toast.add({ title: `${res.domain.domain} added`, color: 'success' })
    open.value = false
    emit('added', res)
  } catch (err) {
    toast.add({ title: 'Domain not added', description: mailErrorMessage(err), color: 'error' })
  } finally {
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

        <template v-if="scope === 'host'">
          <UFormField label="Send through">
            <USelect
              v-model="sendAccountId"
              :items="sendItems"
              placeholder="Choose an account"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Receive through">
            <div class="flex items-center gap-1">
              <USelect
                v-model="receiveAccountId"
                :items="receiveItems"
                placeholder="Don't receive mail"
                :disabled="!receiveItems.length"
                class="flex-1"
              />
              <UButton
                v-if="receiveAccountId"
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                aria-label="Don't receive mail"
                @click="receiveAccountId = undefined"
              />
            </div>
          </UFormField>
        </template>
        <UFormField
          v-else-if="sendItems.length"
          label="Provider account"
        >
          <div class="flex items-center gap-1">
            <USelect
              v-model="sendAccountId"
              :items="sendItems"
              placeholder="The host's account"
              class="flex-1"
            />
            <UButton
              v-if="sendAccountId"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              aria-label="Use the host's account"
              @click="sendAccountId = undefined"
            />
          </div>
        </UFormField>

        <URadioGroup
          v-model="setupMode"
          :items="modeItems"
          variant="card"
          indicator="hidden"
          legend="Setup"
        />

        <template v-if="setupMode === 'manual'">
          <UFormField
            v-for="field in sendProvider?.domainCredentialFields ?? []"
            :key="field.key"
            :label="field.label"
          >
            <UInput
              v-model="keyValues[field.key]"
              :type="field.secret ? 'password' : 'text'"
              autocomplete="off"
              placeholder="Optional"
              class="w-full"
            />
          </UFormField>
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

        <UCheckbox
          v-if="scope === 'host'"
          v-model="makeDefault"
          label="Make this the default domain"
        />
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
          :disabled="!domain.trim()"
        >
          Add
        </UButton>
      </div>
    </template>
  </UModal>
</template>
