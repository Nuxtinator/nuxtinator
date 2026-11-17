<script setup lang="ts">
// Everything about one domain: ownership, DNS or manual steps, checks,
// receiving, webhooks, its own key and From domain. Shown in
// MailDomainSlideover and inline on an org's email settings.
import type { MailAccount, MailDomain, MailDomainCheck, MailDomainResponse, MailDomainSetup, MailProviderInfo, MailRoleCheck, MailScope } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  domain: MailDomain
  accounts: MailAccount[]
  providers: MailProviderInfo[]
  setup?: MailDomainSetup | null
}>(), { orgSlug: null, setup: null })
const emit = defineEmits<{ deleted: [] }>()

const toast = useToast()
const confirmAction = useConfirm()
const base = computed(() => mailApiBase(props.scope, props.orgSlug))
const d = computed(() => props.domain)

const lastSetup = ref<MailDomainSetup | null>(props.setup)
watch(() => props.setup, (s) => {
  if (s) lastSetup.value = s
})
const lastCheck = ref<MailDomainCheck | null>(null)
const ownershipFailed = ref(false)
const busy = ref<string | null>(null)
watch(() => props.domain.id, () => {
  lastSetup.value = props.setup
  lastCheck.value = null
  ownershipFailed.value = false
})

const owned = computed(() => d.value.ownershipStatus === 'verified')
const sendProvider = computed(() => props.providers.find(p => p.id === d.value.sendProvider?.id) ?? null)
const ownAccountIds = computed(() => new Set(props.accounts.map(a => a.id)))
// An org sees webhook URLs only for domains on its own accounts; the host's accounts are the host's to wire up.
const showWebhooks = computed(() => props.scope === 'host'
  || [d.value.sendAccountId, d.value.receiveAccountId].some(id => id && ownAccountIds.value.has(id)))
const receiveAccounts = computed(() => props.accounts
  .filter(a => a.provider && props.providers.find(p => p.id === a.provider)?.supports.receive)
  .map(a => ({ label: a.label, value: a.id })))
const recordsFor = (role: 'send' | 'receive') => d.value.dnsRecords.filter(r => r.role === role)
const roleCheck = (role: 'send' | 'receive'): MailRoleCheck | undefined => lastCheck.value?.roles.find(r => r.role === role)
const setupError = (role: 'send' | 'receive') => lastSetup.value?.roles.find(r => r.role === role)?.error

async function call(name: string, fn: () => Promise<MailDomainResponse>, success?: string) {
  busy.value = name
  try {
    const res = await fn()
    if (res.setup) lastSetup.value = res.setup
    if (res.check) {
      lastCheck.value = res.check
      if (res.check.setup) lastSetup.value = res.check.setup
    }
    await refreshMail(props.scope, 'domains', 'streams')
    if (success) toast.add({ title: success, color: 'success' })
    return res
  } catch (err) {
    toast.add({ title: 'That didn\'t work', description: mailErrorMessage(err), color: 'error' })
    return null
  } finally {
    busy.value = null
  }
}

const check = (name = 'check') => call(name, () => $fetch(`${base.value}/domains/${d.value.id}/check`, { method: 'POST' }))
const patch = (name: string, body: Record<string, unknown>, success: string) =>
  call(name, () => $fetch(`${base.value}/domains/${d.value.id}`, { method: 'PATCH', body }), success)

async function checkOwnership() {
  const res = props.scope === 'org'
    ? await call('ownership', () => $fetch(`${base.value}/domains/${d.value.id}/verify-ownership`, { method: 'POST' }))
    : await check('ownership')
  if (!res) return
  const ok = res.ok ?? res.check?.ownership?.ok ?? res.domain.ownershipStatus === 'verified'
  ownershipFailed.value = !ok
  if (ok) toast.add({ title: 'Ownership confirmed', color: 'success' })
}

const receiveAccountId = ref<string | undefined>(undefined)
async function turnOnReceiving() {
  if (!receiveAccountId.value) return
  await patch('receive', { receiveAccountId: receiveAccountId.value }, 'Receiving turned on')
  receiveAccountId.value = undefined
}
async function turnOffReceiving() {
  if (!await confirmAction({ title: `Stop receiving mail on ${d.value.domain}?`, confirmLabel: 'Stop receiving' })) return
  await patch('receive', { receiveAccountId: null }, 'Receiving turned off')
}

const keyOpen = ref(false)
const keyValues = ref<Record<string, string>>({})
async function saveKey() {
  const creds = Object.fromEntries(Object.entries(keyValues.value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
  if (!Object.keys(creds).length) return
  if (await patch('key', { credentials: creds }, 'Domain key replaced')) {
    keyOpen.value = false
    keyValues.value = {}
  }
}
async function removeKey() {
  if (!await confirmAction({ title: 'Remove the domain\'s own key?', description: 'The domain goes back to sending with the account\'s key.', confirmLabel: 'Remove key' })) return
  await patch('key', { credentials: null }, 'Domain key removed')
}

const fromOpen = ref(false)
const fromValue = ref('')
async function saveFrom() {
  if (await patch('from', { fromDomain: fromValue.value.trim() || null }, 'From domain saved')) fromOpen.value = false
}

const dkimOpen = ref(false)
const dkimValue = ref('')
async function saveDkim() {
  if (await patch('dkim', { dkimSelector: dkimValue.value.trim() || null }, 'DKIM selector saved')) dkimOpen.value = false
}

async function remove() {
  if (!await confirmAction({
    title: `Remove ${d.value.domain}?`,
    description: d.value.setupMode === 'auto' ? 'It is also removed at the provider. Streams using it fall back to the default domain.' : 'Streams using it fall back to the default domain.',
    confirmLabel: 'Remove domain'
  })) return
  busy.value = 'delete'
  try {
    await $fetch(`${base.value}/domains/${d.value.id}`, { method: 'DELETE' })
    await refreshMail(props.scope, 'domains', 'streams')
    toast.add({ title: 'Domain removed', color: 'success' })
    emit('deleted')
  } catch (err) {
    toast.add({ title: 'Remove failed', description: mailErrorMessage(err), color: 'error' })
  } finally {
    busy.value = null
  }
}

const checkIcon = (ok: boolean | null) => ok === true
  ? { name: 'i-lucide-circle-check', class: 'text-(--ui-success)' }
  : ok === false
    ? { name: 'i-lucide-circle-x', class: 'text-(--ui-error)' }
    : { name: 'i-lucide-clock', class: 'text-(--ui-text-dimmed)' }
</script>

<template>
  <div class="space-y-6">
    <section
      v-if="!owned && d.ownershipRecord"
      class="space-y-3"
    >
      <UAlert
        v-if="d.ownershipStatus === 'lapsed'"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`We can no longer confirm you control ${d.domain}.`"
      />
      <h3 class="font-medium flex items-center gap-1">
        Confirm you own {{ d.domain }}
        <InfoTip text="Add this TXT record where you manage the domain's DNS. Nothing is set up at the provider until it is found." />
      </h3>
      <MailOwnershipChallenge
        :record="d.ownershipRecord"
        :checking="busy === 'ownership'"
        :failed="ownershipFailed"
        @check="checkOwnership"
      />
    </section>

    <template v-if="owned">
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          v-if="d.setupMode === 'auto'"
          icon="i-lucide-refresh-cw"
          :loading="busy === 'check'"
          @click="check()"
        >
          Check now
        </UButton>
        <span
          v-if="d.lastCheckedAt"
          class="text-xs text-(--ui-text-muted)"
        >Last checked {{ formatMailDate(d.lastCheckedAt) }}</span>
      </div>

      <UAlert
        v-if="lastSetup?.mxConflict.length"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`${d.domain} already receives mail`"
        :description="`It has MX records at ${lastSetup.mxConflict.join(', ')}. Receiving here would take its mail away from them. Use a subdomain such as inbox.${d.domain}.`"
      />
      <UAlert
        v-if="d.sendError === 'key_rejected'"
        color="error"
        variant="subtle"
        icon="i-lucide-key-round"
        title="The provider rejected the key"
        description="Replace the key on the account or on this domain, then check again."
      />
      <UAlert
        v-if="d.suppressionMode === 'unmanaged'"
        color="warning"
        variant="subtle"
        icon="i-lucide-list-x"
        title="Provider suppression list active"
        description="Clearing a suppression here won't unblock sends on this domain."
      />
      <UAlert
        v-if="lastCheck?.webhooks && !lastCheck.webhooks.ok && lastCheck.webhooks.error !== 'not supported'"
        color="warning"
        variant="subtle"
        icon="i-lucide-webhook"
        title="Webhooks couldn't be set up automatically"
        :description="lastCheck.webhooks.error"
      />

      <section
        v-if="d.sendAccountId"
        class="space-y-3 pt-5 border-t border-(--ui-border)"
      >
        <div class="flex items-center gap-2">
          <h3 class="font-medium">
            Sending
          </h3>
          <span class="text-sm text-(--ui-text-muted)">{{ d.sendProvider?.label }}</span>
          <UBadge
            :color="MAIL_ROLE_STATUS[d.sendStatus].color"
            variant="subtle"
            size="sm"
          >
            {{ MAIL_ROLE_STATUS[d.sendStatus].label }}
          </UBadge>
          <UButton
            v-if="d.setupMode === 'manual'"
            size="sm"
            class="ml-auto"
            :loading="busy === 'verify-send'"
            @click="check('verify-send')"
          >
            Verify sending
          </UButton>
        </div>
        <p
          v-if="setupError('send')"
          class="text-sm text-(--ui-error)"
        >
          Automatic setup failed: {{ setupError('send') }}. Follow the steps below instead.
        </p>
        <ul
          v-if="d.setupMode === 'manual' && roleCheck('send')?.checks.length"
          class="space-y-1"
        >
          <li
            v-for="c in roleCheck('send')!.checks.filter(c => c.key === 'provider' || c.key === 'dns')"
            :key="c.key"
            class="flex items-start gap-2 text-sm"
          >
            <UIcon
              :name="checkIcon(c.ok).name"
              class="size-4 mt-0.5 shrink-0"
              :class="checkIcon(c.ok).class"
            />
            <div class="min-w-0">
              {{ c.label }}
              <div
                v-if="c.detail"
                class="text-xs text-(--ui-text-muted) break-words"
              >
                {{ c.detail }}
              </div>
            </div>
          </li>
        </ul>
        <p
          v-if="roleCheck('send')?.error"
          class="text-sm text-(--ui-error)"
        >
          {{ roleCheck('send')!.error }}
        </p>
        <MailDnsRecords
          v-if="d.setupMode === 'auto' && recordsFor('send').length"
          :records="recordsFor('send')"
          :grouped="false"
        />
        <template v-else-if="d.setupMode === 'manual'">
          <MailManualSteps :steps="d.manualSteps.send" />
          <div class="flex items-center gap-2 text-sm">
            <span class="text-(--ui-text-muted)">DKIM selector</span>
            <template v-if="!dkimOpen">
              <code
                v-if="d.dkimSelector"
                class="font-mono"
              >{{ d.dkimSelector }}</code>
              <span v-else>Not set</span>
              <UButton
                variant="link"
                size="sm"
                class="p-0"
                @click="dkimOpen = true; dkimValue = d.dkimSelector ?? ''"
              >
                Change
              </UButton>
            </template>
            <form
              v-else
              class="flex items-center gap-2"
              @submit.prevent="saveDkim"
            >
              <UInput
                v-model="dkimValue"
                size="sm"
                placeholder="e.g. s1"
              />
              <UButton
                type="submit"
                size="sm"
                :loading="busy === 'dkim'"
              >
                Save
              </UButton>
              <UButton
                variant="ghost"
                color="neutral"
                size="sm"
                @click="dkimOpen = false"
              >
                Cancel
              </UButton>
            </form>
          </div>
        </template>
      </section>

      <section class="space-y-3 pt-5 border-t border-(--ui-border)">
        <div class="flex items-center gap-2">
          <h3 class="font-medium">
            Receiving
          </h3>
          <template v-if="d.receiveAccountId">
            <span class="text-sm text-(--ui-text-muted)">{{ d.receiveProvider?.label }}</span>
            <UBadge
              :color="MAIL_ROLE_STATUS[d.receiveStatus].color"
              variant="subtle"
              size="sm"
            >
              {{ MAIL_ROLE_STATUS[d.receiveStatus].label }}
            </UBadge>
            <UButton
              v-if="d.setupMode === 'manual'"
              size="sm"
              class="ml-auto"
              :loading="busy === 'verify-receive'"
              @click="check('verify-receive')"
            >
              Verify receiving
            </UButton>
          </template>
          <span
            v-else
            class="text-sm text-(--ui-text-muted)"
          >Off</span>
        </div>
        <template v-if="d.receiveAccountId">
          <p
            v-if="setupError('receive')"
            class="text-sm text-(--ui-error)"
          >
            Automatic setup failed: {{ setupError('receive') }}. Follow the steps below instead.
          </p>
          <ul
            v-if="d.setupMode === 'manual' && roleCheck('receive')?.checks.length"
            class="space-y-1"
          >
            <li
              v-for="c in roleCheck('receive')!.checks"
              :key="c.key"
              class="flex items-start gap-2 text-sm"
            >
              <UIcon
                :name="checkIcon(c.ok).name"
                class="size-4 mt-0.5 shrink-0"
                :class="checkIcon(c.ok).class"
              />
              <div class="min-w-0">
                {{ c.label }}
                <div
                  v-if="c.detail"
                  class="text-xs text-(--ui-text-muted) break-words"
                >
                  {{ c.detail }}
                </div>
              </div>
            </li>
          </ul>
          <MailCopyValue
            v-if="d.probeAddress && d.receiveStatus !== 'verified'"
            label="Probe address"
            :value="d.probeAddress"
          />
          <MailDnsRecords
            v-if="d.setupMode === 'auto' && recordsFor('receive').length"
            :records="recordsFor('receive')"
            :grouped="false"
          />
          <MailManualSteps
            v-else-if="d.setupMode === 'manual'"
            :steps="d.manualSteps.receive"
          />
          <UButton
            v-if="d.source !== 'env'"
            variant="link"
            color="neutral"
            size="sm"
            class="p-0"
            @click="turnOffReceiving"
          >
            Stop receiving
          </UButton>
        </template>
        <form
          v-else-if="receiveAccounts.length"
          class="flex items-center gap-2"
          @submit.prevent="turnOnReceiving"
        >
          <USelect
            v-model="receiveAccountId"
            :items="receiveAccounts"
            placeholder="Receive through…"
            class="w-56"
          />
          <UButton
            type="submit"
            :disabled="!receiveAccountId"
            :loading="busy === 'receive'"
          >
            Turn on receiving
          </UButton>
        </form>
      </section>

      <section
        v-if="showWebhooks && d.webhooks.urls && (d.setupMode === 'manual' || d.webhooks.state !== 'connected')"
        class="space-y-3 pt-5 border-t border-(--ui-border)"
      >
        <div class="flex items-center gap-2">
          <h3 class="font-medium">
            Webhooks
          </h3>
          <UBadge
            :color="MAIL_WEBHOOK_STATES[d.webhooks.state].color"
            variant="subtle"
            size="sm"
          >
            {{ MAIL_WEBHOOK_STATES[d.webhooks.state].label }}
          </UBadge>
        </div>
        <p class="text-sm text-(--ui-text-muted)">
          Events to send: {{ d.webhooks.required.join(', ') }}
        </p>
        <MailCopyValue
          label="Events URL"
          :value="d.webhooks.urls.events"
        />
        <template v-if="d.receiveAccountId">
          <MailCopyValue
            label="Inbound URL (parsed)"
            :value="d.webhooks.urls.inbound"
          />
          <MailCopyValue
            label="Inbound URL (raw MIME)"
            :value="d.webhooks.urls.inboundMime"
          />
        </template>
        <UButton
          v-if="d.webhooks.state !== 'connected'"
          variant="outline"
          color="neutral"
          icon="i-lucide-check"
          :loading="busy === 'webhooks'"
          @click="patch('webhooks', { confirmWebhooks: true }, 'Webhooks marked as set up')"
        >
          I've set up the webhooks
        </UButton>
      </section>
      <div
        v-else-if="showWebhooks && d.webhooks.state === 'connected'"
        class="flex items-center gap-2 text-sm pt-5 border-t border-(--ui-border)"
      >
        <UIcon
          name="i-lucide-webhook"
          class="size-4 text-(--ui-success)"
        />
        Webhooks: connected
      </div>

      <section
        v-if="d.sendAccountId && sendProvider?.domainCredentialFields.length && d.source !== 'env'"
        class="space-y-3 pt-5 border-t border-(--ui-border)"
      >
        <div class="flex items-center gap-2">
          <h3 class="font-medium flex items-center gap-1">
            Domain key
            <InfoTip text="A key that only works for this domain. Without one, the domain sends with the account's key." />
          </h3>
          <span class="text-sm text-(--ui-text-muted)">{{ d.hasOwnCredentials ? 'Set' : 'Uses the account\'s key' }}</span>
          <UButton
            v-if="!keyOpen"
            variant="link"
            size="sm"
            class="p-0 ml-auto"
            @click="keyOpen = true"
          >
            {{ d.hasOwnCredentials ? 'Replace' : 'Add' }}
          </UButton>
        </div>
        <MailCapabilityBadges
          v-if="d.hasOwnCredentials"
          :capabilities="d.capabilities"
        />
        <form
          v-if="keyOpen"
          class="space-y-3 rounded-md bg-(--ui-bg-elevated) p-3"
          @submit.prevent="saveKey"
        >
          <UFormField
            v-for="field in sendProvider.domainCredentialFields"
            :key="field.key"
            :label="field.label"
          >
            <UInput
              v-model="keyValues[field.key]"
              :type="field.secret ? 'password' : 'text'"
              autocomplete="off"
              class="w-full"
            />
          </UFormField>
          <div class="flex gap-2">
            <UButton
              type="submit"
              size="sm"
              :loading="busy === 'key'"
            >
              Save
            </UButton>
            <UButton
              variant="ghost"
              color="neutral"
              size="sm"
              @click="keyOpen = false"
            >
              Cancel
            </UButton>
            <UButton
              v-if="d.hasOwnCredentials"
              variant="outline"
              color="error"
              size="sm"
              class="ml-auto"
              @click="removeKey"
            >
              Remove key
            </UButton>
          </div>
        </form>
      </section>

      <section
        v-if="scope === 'host' && d.source !== 'env'"
        class="space-y-2 pt-5 border-t border-(--ui-border)"
      >
        <div class="flex items-center gap-2">
          <h3 class="font-medium flex items-center gap-1">
            From domain
            <InfoTip text="Send with this domain in the From address while the provider sends as the domain above, e.g. example.org while mail goes through mail.example.org. DMARC is checked there." />
          </h3>
          <span class="text-sm text-(--ui-text-muted)">{{ d.fromDomain ?? 'Same as the domain' }}</span>
          <UButton
            v-if="!fromOpen"
            variant="link"
            size="sm"
            class="p-0 ml-auto"
            @click="fromOpen = true; fromValue = d.fromDomain ?? ''"
          >
            Change
          </UButton>
        </div>
        <form
          v-if="fromOpen"
          class="flex items-center gap-2 rounded-md bg-(--ui-bg-elevated) p-3"
          @submit.prevent="saveFrom"
        >
          <UInput
            v-model="fromValue"
            placeholder="example.org"
            class="flex-1"
          />
          <UButton
            type="submit"
            size="sm"
            :loading="busy === 'from'"
          >
            Save
          </UButton>
          <UButton
            variant="ghost"
            color="neutral"
            size="sm"
            @click="fromOpen = false"
          >
            Cancel
          </UButton>
        </form>
      </section>
    </template>

    <div
      v-if="d.source !== 'env'"
      class="pt-5 border-t border-(--ui-border)"
    >
      <UButton
        color="error"
        variant="outline"
        icon="i-lucide-trash-2"
        :loading="busy === 'delete'"
        @click="remove"
      >
        Remove domain
      </UButton>
    </div>
  </div>
</template>
