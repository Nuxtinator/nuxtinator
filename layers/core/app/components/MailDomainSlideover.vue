<script setup lang="ts">
import type { MailDomainSetup, MailScope } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  domainId: string | null
  setup?: MailDomainSetup | null
}>(), { orgSlug: null, setup: null })
const open = defineModel<boolean>('open', { default: false })

const { data: domainsData } = useMailDomains(props.scope, () => props.orgSlug)
const { data: accountsData } = useMailAccounts(props.scope, () => props.orgSlug)
const domain = computed(() => domainsData.value?.domains.find(d => d.id === props.domainId) ?? null)
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="domain?.domain ?? 'Domain'"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <MailDomainDetail
        v-if="domain"
        :scope="scope"
        :org-slug="orgSlug"
        :domain="domain"
        :accounts="accountsData?.accounts ?? []"
        :providers="accountsData?.providers ?? []"
        :setup="setup"
        @deleted="open = false"
      />
    </template>
  </USlideover>
</template>
