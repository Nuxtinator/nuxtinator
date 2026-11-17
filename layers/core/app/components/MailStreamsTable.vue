<script setup lang="ts">
import type { MailScope, MailStreamOverview } from '#core/app/composables/useMailAdmin'

const props = withDefaults(defineProps<{
  scope: MailScope
  orgSlug?: string | null
  title?: string
  showDefault?: boolean
}>(), { orgSlug: null, title: 'Streams', showDefault: undefined })

const toast = useToast()
const { data, pending, error, refresh } = useMailStreams(props.scope, () => props.orgSlug)
const streams = computed(() => data.value?.streams ?? [])
const domains = computed(() => data.value?.domains ?? [])
const withDefault = computed(() => props.showDefault ?? props.scope === 'host')

const DEFAULT = '*'
// Unsaved picks per stream; a missing key means "as saved".
const draft = ref<Record<string, string | null>>({})
const saved = (id: string) => id === DEFAULT ? (data.value?.defaultDomainId ?? null) : (streams.value.find(s => s.id === id)?.routeDomainId ?? null)
const current = (id: string) => id in draft.value ? draft.value[id]! : saved(id)
const changed = computed(() => Object.keys(draft.value).filter(id => draft.value[id] !== saved(id)))
const dirty = computed(() => changed.value.length > 0)
function discard() {
  draft.value = {}
}
useUnsavedGuard(() => dirty.value, discard)

function setPick(id: string, value: string | null) {
  draft.value = { ...draft.value, [id]: value }
}

const defaultItems = computed(() => domains.value
  .filter(d => d.canSend && d.ownershipStatus === 'verified')
  .map(d => ({ label: d.domain, value: d.id })))
const itemsFor = (s: MailStreamOverview) => domains.value
  .filter(d => s.qualifyingDomainIds.includes(d.id))
  .map(d => ({ label: d.domain, value: d.id }))
const domainName = (id: string | null) => domains.value.find(d => d.id === id)?.domain ?? null

const defaultPlaceholder = computed(() => data.value?.fallbackDomain ? `Environment (${data.value.fallbackDomain})` : 'None')
function placeholderFor(s: MailStreamOverview) {
  if (!s.routeDomainId && !s.resolvedDomain) return 'Choose a domain'
  const fallback = s.routeDomainId ? data.value?.fallbackDomain : (s.resolvedDomain ?? data.value?.fallbackDomain)
  return fallback ? `Default (${fallback})` : 'Default'
}

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch(`${mailApiBase(props.scope, props.orgSlug)}/streams`, {
      method: 'PUT',
      body: { routes: changed.value.map(stream => ({ stream, domainId: draft.value[stream] ?? null })) }
    })
    discard()
    await refreshMail(props.scope, 'streams', 'domains')
    toast.add({ title: 'Streams saved', color: 'success' })
  } catch (err) {
    toast.add({ title: 'Not saved', description: mailErrorMessage(err), color: 'error' })
    await refresh()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <h2 class="text-lg font-semibold flex items-center gap-1">
          {{ title }}
          <InfoTip>
            <p>Each kind of mail goes out from the domain picked here. Without a pick it uses the default domain.</p>
            <p>Only domains that can carry a stream are offered: a stream people reply to needs a domain that receives mail.</p>
          </InfoTip>
        </h2>
      </template>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        class="m-4"
        :title="mailErrorMessage(error, 'Streams didn\'t load')"
        :actions="[{ label: 'Retry', color: 'neutral', variant: 'outline', onClick: () => { refresh() } }]"
      />
      <p
        v-else-if="!pending && !streams.length && !withDefault"
        class="p-4 text-sm text-(--ui-text-muted)"
      >
        No streams can use your own domain.
      </p>
      <ul
        v-else
        class="divide-y divide-(--ui-border)"
      >
        <li
          v-if="withDefault"
          class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4"
          data-stream="*"
        >
          <div class="min-w-0">
            <div class="font-medium">
              Default domain
            </div>
            <div class="text-xs text-(--ui-text-muted)">
              Every stream without its own pick
            </div>
          </div>
          <div class="flex items-center gap-1 w-full sm:w-72 shrink-0">
            <USelect
              :model-value="current(DEFAULT) ?? undefined"
              :items="defaultItems"
              :placeholder="defaultPlaceholder"
              class="flex-1"
              aria-label="Default domain"
              @update:model-value="(v: string) => setPick(DEFAULT, v)"
            />
            <UButton
              v-if="current(DEFAULT)"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              aria-label="Clear the default domain"
              @click="setPick(DEFAULT, null)"
            />
          </div>
        </li>
        <li
          v-for="s in streams"
          :key="s.id"
          class="p-4 space-y-2"
          :data-stream="s.id"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="font-medium flex items-center gap-2">
                {{ s.label }}
                <UBadge
                  v-if="s.needsReceive"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                >
                  Needs receiving
                </UBadge>
                <UBadge
                  v-if="s.bulk"
                  color="neutral"
                  variant="subtle"
                  size="sm"
                >
                  Bulk
                </UBadge>
              </div>
              <div
                v-if="!s.resolvedDomain && !current(s.id)"
                class="text-xs text-(--ui-error)"
              >
                No domain can send this yet
              </div>
              <div
                v-else-if="current(s.id) !== s.routeDomainId"
                class="text-xs text-(--ui-text-muted)"
              >
                Will send from {{ domainName(current(s.id)) ?? 'the default domain' }}
              </div>
              <div
                v-else
                class="text-xs text-(--ui-text-muted)"
              >
                Sends from {{ s.resolvedDomain }}
              </div>
            </div>
            <div class="flex items-center gap-1 w-full sm:w-72 shrink-0">
              <USelect
                :model-value="current(s.id) ?? undefined"
                :items="itemsFor(s)"
                :placeholder="placeholderFor(s)"
                :disabled="!itemsFor(s).length && !current(s.id)"
                class="flex-1"
                :aria-label="`Domain for ${s.label}`"
                @update:model-value="(v: string) => setPick(s.id, v)"
              />
              <UButton
                v-if="current(s.id)"
                icon="i-lucide-x"
                color="neutral"
                variant="ghost"
                :aria-label="`Use the default domain for ${s.label}`"
                @click="setPick(s.id, null)"
              />
            </div>
          </div>
          <UAlert
            v-if="s.bulkWarning"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Give bulk mail its own domain"
            description="This domain reports every delivery, so bulk sends here flood the event webhook."
          />
        </li>
      </ul>
    </UCard>

    <SaveBar
      :dirty="dirty"
      :saving="saving"
      @save="save"
      @discard="discard"
    />
  </div>
</template>
