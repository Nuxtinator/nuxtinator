<script setup lang="ts">
import type { MailAccount, MailProviderInfo, MailScope, MailVerifyResult } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  account: MailAccount | null
  providers: MailProviderInfo[]
}>(), { orgSlug: null })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [account: MailAccount] }>()

const toast = useToast()
const confirmAction = useConfirm()
const base = computed(() => mailApiBase(props.scope, props.orgSlug))

const providerId = ref<string | undefined>(undefined)
const label = ref('')
const values = ref<Record<string, string>>({})
// Secret fields that already hold a value stay masked until "Replace" opens them.
const replacing = ref<Record<string, boolean>>({})
const saving = ref(false)
const lastVerify = ref<MailVerifyResult>(null)

const isNew = computed(() => !props.account)
// The host sees an org's own account but only the org changes it.
const orgOwned = computed(() => props.scope === 'host' && !!props.account?.orgId)
const readOnly = computed(() => props.account?.source === 'env' || orgOwned.value)
const provider = computed(() => props.providers.find(p => p.id === (props.account?.provider ?? providerId.value)) ?? null)
const providerItems = computed(() => props.providers.map(p => ({ label: p.label, value: p.id })))
const providerNotes = computed(() => [provider.value?.notes.send, provider.value?.notes.receive].filter(Boolean) as string[])

function reset() {
  providerId.value = props.account?.provider ?? undefined
  label.value = props.account && props.account.source !== 'env' ? props.account.label : ''
  replacing.value = {}
  values.value = Object.fromEntries((provider.value?.credentialFields ?? [])
    .map(field => [field.key, field.secret ? '' : (props.account?.credentials[field.key] ?? '')]))
  lastVerify.value = null
}
watch(open, (v) => {
  if (v) reset()
}, { immediate: true })
watch(providerId, () => {
  if (isNew.value) for (const field of provider.value?.credentialFields ?? []) values.value[field.key] ??= ''
})

const masked = (key: string) => props.account?.credentials[key]

const missing = computed(() => (provider.value?.credentialFields ?? [])
  .filter(f => !f.optional && !values.value[f.key]?.trim() && !(masked(f.key) && !replacing.value[f.key]))
  .map(f => f.label))

function credentialPayload(): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const field of provider.value?.credentialFields ?? []) {
    const v = values.value[field.key]?.trim() ?? ''
    if (!v) continue
    if (!isNew.value && !field.secret && v === (props.account?.credentials[field.key] ?? '')) continue
    out[field.key] = v
  }
  return Object.keys(out).length ? out : undefined
}

async function save() {
  if (!provider.value || missing.value.length) return
  saving.value = true
  try {
    const body = { provider: provider.value.id, label: label.value.trim() || null, credentials: credentialPayload() }
    const res = isNew.value
      ? await $fetch<{ account: MailAccount, verify: MailVerifyResult }>(`${base.value}/accounts`, { method: 'POST', body })
      : await $fetch<{ account: MailAccount, verify: MailVerifyResult }>(`${base.value}/accounts/${props.account!.id}`, { method: 'PATCH', body: { label: body.label, credentials: body.credentials } })
    await refreshMail(props.scope, 'accounts', 'domains')
    emit('saved', res.account)
    lastVerify.value = res.verify
    if (res.verify && !res.verify.ok) {
      toast.add({ title: 'Saved, but the provider refused the key', description: res.verify.error, color: 'warning' })
    } else {
      toast.add({ title: isNew.value ? 'Account added' : 'Account saved', color: 'success' })
      open.value = false
    }
  } catch (err) {
    toast.add({ title: 'Not saved', description: mailErrorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function rotate() {
  if (!props.account) return
  if (!await confirmAction({
    title: 'Rotate webhook URLs?',
    description: 'The current URLs stop working. Domains set up automatically get the new ones; anywhere you pasted them by hand needs the new URLs.',
    confirmLabel: 'Rotate'
  })) return
  try {
    const res = await $fetch<{ account: MailAccount }>(`${base.value}/accounts/${props.account.id}/rotate-webhooks`, { method: 'POST' })
    emit('saved', res.account)
    await refreshMail(props.scope, 'accounts', 'domains')
    toast.add({ title: 'Webhook URLs rotated', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Rotation failed', description: mailErrorMessage(err), color: 'error' })
  }
}

async function remove() {
  if (!props.account) return
  if (!await confirmAction({ title: `Delete ${props.account.label}?`, confirmLabel: 'Delete account' })) return
  try {
    await $fetch(`${base.value}/accounts/${props.account.id}`, { method: 'DELETE' })
    await refreshMail(props.scope, 'accounts')
    toast.add({ title: 'Account deleted', color: 'success' })
    open.value = false
  } catch (err) {
    toast.add({ title: 'Delete failed', description: mailErrorMessage(err), color: 'error' })
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="isNew ? 'Add account' : account?.label"
  >
    <template #body>
      <form
        id="mail-account-form"
        class="space-y-5"
        @submit.prevent="save"
      >
        <UAlert
          v-if="readOnly"
          color="neutral"
          variant="subtle"
          icon="i-lucide-lock"
          :title="orgOwned ? `Belongs to ${account?.orgName ?? 'an organization'}` : 'Set by environment variables'"
        />

        <UFormField
          v-if="isNew"
          required
        >
          <template #label>
            Provider <InfoTip v-if="providerNotes.length">
              <p
                v-for="note in providerNotes"
                :key="note"
              >
                {{ note }}
              </p>
            </InfoTip>
          </template>
          <USelect
            v-model="providerId"
            :items="providerItems"
            placeholder="Choose a provider"
            class="w-full"
          />
        </UFormField>
        <UFormField v-else>
          <template #label>
            Provider <InfoTip v-if="providerNotes.length">
              <p
                v-for="note in providerNotes"
                :key="note"
              >
                {{ note }}
              </p>
            </InfoTip>
          </template>
          <span class="text-sm">{{ account?.providerLabel ?? 'None (local and log only)' }}</span>
        </UFormField>

        <UFormField
          v-if="!readOnly && provider"
          label="Name"
        >
          <UInput
            v-model="label"
            :placeholder="provider.label"
            class="w-full"
          />
        </UFormField>

        <UFormField
          v-for="field in provider?.credentialFields ?? []"
          :key="field.key"
          :required="!field.optional && isNew"
        >
          <template #label>
            {{ field.label }}
            <InfoTip
              v-if="field.help"
              :text="field.help"
            />
          </template>
          <div
            v-if="field.secret && masked(field.key) && !replacing[field.key]"
            class="flex items-center gap-3"
          >
            <code class="font-mono text-sm">{{ masked(field.key) }}</code>
            <UButton
              v-if="!readOnly"
              variant="link"
              size="sm"
              class="p-0"
              @click="replacing[field.key] = true"
            >
              Replace
            </UButton>
          </div>
          <span
            v-else-if="readOnly"
            class="text-sm"
            :class="masked(field.key) ? 'font-mono' : 'text-(--ui-text-muted)'"
          >{{ masked(field.key) ?? 'Not set' }}</span>
          <UInput
            v-else
            v-model="values[field.key]"
            :type="field.secret ? 'password' : 'text'"
            autocomplete="off"
            :placeholder="field.optional ? 'Optional' : undefined"
            class="w-full"
          />
        </UFormField>

        <div
          v-if="(account?.provider && account.hasKey) || lastVerify"
          class="space-y-2"
        >
          <h3 class="text-sm font-medium">
            What the key can do
          </h3>
          <MailCapabilityBadges :capabilities="account?.capabilities ?? {}" />
          <p
            v-if="lastVerify && !lastVerify.ok"
            class="text-sm text-(--ui-error)"
          >
            {{ lastVerify.error }}
          </p>
        </div>

        <div
          v-if="account?.webhookUrls"
          class="space-y-2"
        >
          <h3 class="text-sm font-medium flex items-center gap-1">
            Webhook URLs
            <InfoTip text="Domains set up automatically use these already. Paste them at the provider only when a domain's setup asks for it." />
          </h3>
          <MailCopyValue
            label="Events"
            :value="account.webhookUrls.events"
          />
          <MailCopyValue
            label="Inbound (parsed)"
            :value="account.webhookUrls.inbound"
          />
          <MailCopyValue
            label="Inbound (raw MIME)"
            :value="account.webhookUrls.inboundMime"
          />
          <UButton
            variant="outline"
            color="neutral"
            size="sm"
            icon="i-lucide-refresh-cw"
            @click="rotate"
          >
            Rotate webhook URLs
          </UButton>
        </div>
      </form>
    </template>
    <template
      v-if="!readOnly"
      #footer
    >
      <div class="flex items-center gap-2 w-full">
        <UButton
          v-if="!isNew"
          color="error"
          variant="outline"
          icon="i-lucide-trash-2"
          @click="remove"
        >
          Delete
        </UButton>
        <span
          v-if="missing.length && provider"
          class="text-xs text-(--ui-text-muted) ml-auto"
        >Missing: {{ missing.join(', ') }}</span>
        <div
          class="flex gap-2"
          :class="missing.length && provider ? '' : 'ml-auto'"
        >
          <UButton
            variant="ghost"
            color="neutral"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            form="mail-account-form"
            :loading="saving"
            :disabled="!provider || missing.length > 0"
          >
            Save
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
