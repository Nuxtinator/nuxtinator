<script setup lang="ts">
// Per-org inbox configuration (inbox.settings.manage): inbound mail domain, shared
// contact address, auto-ack, the auto-close threshold, the contact-form API
// key, who is emailed about unassigned mail, and the AI grounding source URLs. Values are org-scoped
// overrides on top of code defaults —
// clearing a field falls back to the deployment default at read time.
definePageMeta({ middleware: 'auth' })

const inboxPath = useInboxPath()

interface InboxAdminSettings {
  inboundDomain: string
  contactAddress: string
  brandFromName: string
  autoAckEnabled: boolean
  contactFormApiKey: string
  groundingSourceUrls: string[]
  notifyUserIds: string[]
  autoCloseDays: number
  // False for org admins in multi mode: only an operator sets these two.
  mailIdentityEditable: boolean
}

const toast = useToast()
const form = ref<InboxAdminSettings | null>(null)
const forbidden = ref(false)
const saving = ref(false)
// Textarea-friendly view of the URL list (one per line).
const urlsText = ref('')

// Sending identities (settings managers): every inbox user with their alias,
// joined from the assignees list (names) and the identities list (aliases).
interface IdentityRow {
  userId: string
  displayName: string
  alias: string
  hasSignature: boolean
  saving: boolean
}
const identities = ref<IdentityRow[]>([])

// Candidate notify recipients, shaped for USelectMenu (value = user id).
// Same source as the identities table: everyone who can open the inbox.
const userItems = computed(() =>
  identities.value.map(r => ({ id: r.userId, label: r.displayName || 'Unnamed user' }))
)

async function loadIdentities() {
  const [assignees, ids] = await Promise.all([
    $fetch<{ users: Array<{ id: string, displayName: string }> }>('/api/inbox/assignees'),
    $fetch<{ identities: Array<{ userId: string, alias: string | null, hasSignature: boolean }> }>('/api/inbox/identities')
  ])
  const byId = new Map(ids.identities.map(i => [i.userId, i]))
  identities.value = assignees.users.map(u => ({
    userId: u.id,
    displayName: u.displayName,
    alias: byId.get(u.id)?.alias ?? '',
    hasSignature: byId.get(u.id)?.hasSignature ?? false,
    saving: false
  }))
}

async function saveAlias(row: IdentityRow) {
  row.saving = true
  try {
    const res = await $fetch<{ alias: string | null }>(`/api/inbox/identities/${row.userId}`, {
      method: 'PUT',
      body: { alias: row.alias.trim() || null }
    })
    row.alias = res.alias ?? ''
    toast.add({ title: `Alias saved for ${row.displayName}`, icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode
    toast.add({
      title: status === 400 ? 'That alias is invalid or already taken' : 'Could not save alias',
      color: 'error'
    })
  } finally {
    row.saving = false
  }
}

async function load() {
  try {
    const s = await $fetch<InboxAdminSettings>('/api/inbox/settings')
    form.value = s
    urlsText.value = s.groundingSourceUrls.join('\n')
    await loadIdentities()
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 403) {
      forbidden.value = true
    } else {
      toast.add({ title: 'Could not load inbox settings', color: 'error' })
    }
  }
}
await load()

async function save() {
  if (!form.value) return
  saving.value = true
  try {
    const updated = await $fetch<InboxAdminSettings>('/api/inbox/settings', {
      method: 'PUT',
      body: {
        ...(form.value.mailIdentityEditable
          ? { inboundDomain: form.value.inboundDomain, contactAddress: form.value.contactAddress }
          : {}),
        brandFromName: form.value.brandFromName,
        autoAckEnabled: form.value.autoAckEnabled,
        contactFormApiKey: form.value.contactFormApiKey,
        groundingSourceUrls: urlsText.value.split('\n').map(s => s.trim()).filter(Boolean),
        notifyUserIds: form.value.notifyUserIds,
        autoCloseDays: form.value.autoCloseDays
      }
    })
    form.value = updated
    urlsText.value = updated.groundingSourceUrls.join('\n')
    toast.add({ title: 'Inbox settings saved', icon: 'i-lucide-save', color: 'success' })
  } catch (err) {
    const e = err as { statusCode?: number, data?: { statusMessage?: string } }
    toast.add({
      title: 'Save failed',
      description: e.data?.statusMessage || (e.statusCode === 400 ? 'Check the domain and address formats.' : undefined),
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

function generateApiKey() {
  if (!form.value) return
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  form.value.contactFormApiKey = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <header class="space-y-2">
      <UButton
        :to="inboxPath('/inbox')"
        label="Back to inbox"
        icon="i-lucide-arrow-left"
        size="xs"
        color="neutral"
        variant="ghost"
        class="-ml-2"
      />
      <h1 class="text-2xl font-bold">
        Inbox settings
      </h1>
    </header>

    <UAlert
      v-if="forbidden"
      icon="i-lucide-lock"
      color="warning"
      variant="subtle"
      title="No access"
      description="You need the Manage inbox settings permission."
    />

    <template v-else-if="form">
      <div class="space-y-4">
        <UFormField>
          <template #label>
            Inbound mail domain
            <InfoTip text="The (sub)domain inbound mail arrives on, e.g. mail.example.com. Mail on it is routed to this organization." />
          </template>
          <UInput v-model="form.inboundDomain" placeholder="mail.example.com" class="w-full" :disabled="!form.mailIdentityEditable" />
        </UFormField>

        <UFormField :help="form.mailIdentityEditable ? undefined : 'Set by the platform operator.'">
          <template #label>
            Shared contact address
            <InfoTip text="The From address for team replies and the base of contact+token reply addresses. Must be on the inbound domain." />
          </template>
          <UInput v-model="form.contactAddress" placeholder="contact@mail.example.com" class="w-full" :disabled="!form.mailIdentityEditable" />
        </UFormField>

        <UFormField>
          <template #label>
            Brand From name
            <InfoTip text="Display name on shared-address sends and courtesy replies. Personal-alias sends use the agent's own name." />
          </template>
          <UInput v-model="form.brandFromName" placeholder="Acme Support" class="w-full" />
        </UFormField>

        <UFormField>
          <template #label>
            Auto-acknowledge new conversations
            <InfoTip text="Sends a courtesy &quot;we received your message&quot; to authenticated senders who open a new conversation." />
          </template>
          <USwitch v-model="form.autoAckEnabled" />
        </UFormField>

        <UFormField>
          <template #label>
            Auto-close after (days)
            <InfoTip>
              <p>A pending conversation with no reply from the contact for this many days is closed by the nightly sweep.</p>
              <p>0 never auto-closes. A new message always reopens a closed conversation.</p>
            </InfoTip>
          </template>
          <UInputNumber v-model="form.autoCloseDays" :min="0" :max="365" class="w-40" />
        </UFormField>

        <UFormField>
          <template #label>
            Contact-form API key
            <InfoTip text="Server-to-server key for the public contact-form endpoint; submissions are routed to this organization. Empty disables the form." />
          </template>
          <div class="flex gap-2">
            <UInput v-model="form.contactFormApiKey" class="flex-1 font-mono" />
            <UButton
              label="Generate"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="subtle"
              @click="generateApiKey"
            />
          </div>
        </UFormField>

        <UFormField>
          <template #label>
            Email on unassigned mail
            <InfoTip text="These users are emailed when mail lands on an unassigned conversation. Everyone with inbox access still gets the in-app notification." />
          </template>
          <USelectMenu
            v-model="form.notifyUserIds"
            :items="userItems"
            value-key="id"
            label-key="label"
            multiple
            :search-input="{ placeholder: 'Search users...' }"
            placeholder="No email recipients"
            class="w-full"
          />
        </UFormField>

        <UFormField>
          <template #label>
            AI grounding source URLs
            <InfoTip text="Pages snapshotted daily as reference material for AI reply drafts." />
          </template>
          <UTextarea v-model="urlsText" :rows="4" placeholder="One URL per line" class="w-full font-mono" />
        </UFormField>
      </div>

      <div class="flex justify-end">
        <UButton
          label="Save settings"
          icon="i-lucide-save"
          :loading="saving"
          @click="save"
        />
      </div>

      <section class="space-y-3 pt-4 border-t border-(--ui-border)">
        <h2 class="text-lg font-semibold">
          Sending identities
          <InfoTip text="An alias routes <alias>@ the inbound domain to that teammate and gives them a personal From address. Each user edits their own signature." />
        </h2>
        <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
          <li
            v-for="row in identities"
            :key="row.userId"
            class="flex items-center gap-3 p-3"
          >
            <div class="min-w-0 flex-1">
              <div class="font-medium truncate">
                {{ row.displayName }}
              </div>
              <UBadge
                v-if="row.hasSignature"
                label="Has signature"
                color="neutral"
                variant="subtle"
                size="sm"
              />
            </div>
            <UInput
              v-model="row.alias"
              placeholder="alias"
              class="w-40 font-mono"
            />
            <UButton
              label="Save"
              size="xs"
              color="neutral"
              variant="subtle"
              :loading="row.saving"
              @click="saveAlias(row)"
            />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
