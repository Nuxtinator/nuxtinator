<script setup lang="ts">
import type { MailDomainResponse, MailDomainSetup } from '#core/app/composables/useMailAdmin'

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const toast = useToast()
const orgSlug = computed(() => route.params.orgSlug as string)

const { data: domainsData, pending: domainsPending, error: domainsError, refresh: refreshDomains } = useMailDomains('org', orgSlug)
const { data: streamsData, error: streamsError, refresh: refreshStreams } = useMailStreams('org', orgSlug)
const { data: accountsData } = useMailAccounts('org', orgSlug)

const loadError = computed(() => domainsError.value ?? streamsError.value)
async function retry() {
  await Promise.all([refreshDomains(), refreshStreams()])
}

const domains = computed(() => domainsData.value?.domains ?? [])
// The domain the org sends from, else the first one it added.
const primary = computed(() => domains.value.find(d => d.id === streamsData.value?.defaultDomainId) ?? domains.value[0] ?? null)
const hostDomain = computed(() => streamsData.value?.fallbackDomain ?? 'the host\'s domain')
const lastSetup = ref<MailDomainSetup | null>(null)

const addOpen = ref(false)
function onAdded(res: MailDomainResponse) {
  lastSetup.value = res.setup ?? null
}

const switchOn = computed(() => !!primary.value && streamsData.value?.defaultDomainId === primary.value.id)
const canSwitch = computed(() => primary.value?.ownershipStatus === 'verified' && primary.value.sendStatus === 'verified')
const switching = ref(false)
async function setSwitch(on: boolean) {
  if (!primary.value) return
  switching.value = true
  try {
    await $fetch(`/api/o/${orgSlug.value}/mail/streams`, { method: 'PUT', body: { routes: [{ stream: '*', domainId: on ? primary.value.id : null }] } })
    await refreshMail('org', 'streams', 'domains')
    toast.add({ title: on ? `Mail now goes out from ${primary.value.domain}` : `Mail goes out from ${hostDomain.value} again`, color: 'success' })
  } catch (err) {
    toast.add({ title: 'Not changed', description: mailErrorMessage(err), color: 'error' })
  } finally {
    switching.value = false
  }
}

const moved = computed(() => (streamsData.value?.streams ?? []).filter(s => primary.value && s.resolvedDomain === primary.value.domain))
const waiting = computed(() => (streamsData.value?.streams ?? []).filter(s => s.needsReceive && primary.value && s.resolvedDomain !== primary.value.domain))

const advancedOpen = ref(false)
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <div class="space-y-4">
      <h1 class="text-3xl font-bold">
        Email
      </h1>

      <UAlert
        v-if="loadError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="mailErrorMessage(loadError, 'Email settings didn\'t load')"
        :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { retry() } }]"
      />

      <template v-else>
        <UCard>
          <template #header>
            <h2 class="text-lg font-semibold flex items-center gap-1">
              Our domain
              <InfoTip>
                <p>Send your organization's mail from a domain you own. You prove you control it with a DNS record, then add the records that let it send.</p>
                <p>Password resets and other account mail always come from {{ hostDomain }}.</p>
              </InfoTip>
            </h2>
          </template>

          <div
            v-if="domainsPending && !domains.length"
            class="text-sm text-(--ui-text-muted)"
          >
            Loading...
          </div>

          <div
            v-else-if="!primary"
            class="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <p class="text-sm">
              Your mail is sent from {{ hostDomain }}. Add your own domain to send from it.
            </p>
            <UButton
              icon="i-lucide-globe"
              class="shrink-0"
              @click="addOpen = true"
            >
              Use our own domain
            </UButton>
          </div>

          <div
            v-else
            class="space-y-6"
          >
            <div
              v-if="primary.ownershipStatus === 'verified'"
              class="space-y-2"
            >
              <USwitch
                :model-value="switchOn"
                :disabled="switching || (!switchOn && !canSwitch)"
                :loading="switching"
                :label="`Send our mail from ${primary.domain}`"
                size="lg"
                @update:model-value="setSwitch"
              />
              <p
                v-if="!canSwitch && !switchOn"
                class="text-sm text-(--ui-text-muted)"
              >
                Turns on once sending is verified.
              </p>
              <p
                v-else-if="switchOn"
                class="text-sm text-(--ui-text-muted)"
              >
                <template v-if="moved.length">
                  Moved: {{ moved.map(s => s.label).join(', ') }}.
                </template>
                <template v-if="waiting.length">
                  Waiting on receiving: {{ waiting.map(s => s.label).join(', ') }}.
                </template>
              </p>
            </div>

            <MailDomainDetail
              scope="org"
              :org-slug="orgSlug"
              :domain="primary"
              :accounts="accountsData?.accounts ?? []"
              :host-receive-account="accountsData?.hostReceiveAccount ?? null"
              :providers="accountsData?.providers ?? []"
              :setup="lastSetup"
              :fallback-domain="hostDomain"
            />
          </div>
        </UCard>

        <UButton
          color="neutral"
          variant="ghost"
          :trailing-icon="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :aria-expanded="advancedOpen"
          class="-mx-2.5 text-lg font-semibold"
          @click="advancedOpen = !advancedOpen"
        >
          Advanced
        </UButton>
        <template v-if="advancedOpen">
          <MailStreamsTable
            scope="org"
            :org-slug="orgSlug"
            title="Domain per stream"
          />
          <MailDomainsTable
            scope="org"
            :org-slug="orgSlug"
            title="Our domains"
          />
          <MailAccountsTable
            scope="org"
            :org-slug="orgSlug"
            title="Our provider accounts"
            add-label="Use our own provider account"
          />
        </template>

        <MailSuppressionsTable
          scope="org"
          :org-slug="orgSlug"
        />
      </template>
    </div>

    <MailAddDomainModal
      v-model:open="addOpen"
      scope="org"
      :org-slug="orgSlug"
      @added="onAdded"
    />
  </div>
</template>
