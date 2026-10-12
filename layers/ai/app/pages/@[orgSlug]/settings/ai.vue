<script setup lang="ts">
import type { AiOrgConfig, AiOrgProvider, AiModelInfo, AiModelKind, AiProvider, AiEmbeddingModelInfo, AiReindexStatus } from '#ai'

// Org-level AI settings, rendered inside the tenancy layer's settings shell
// (registered via core's org-settings-section registry). Lets an org bring its
// own key per provider and enable that provider's models, and choose its
// default and per-feature models; anything left unset falls through to the
// host's choices.

definePageMeta({
  middleware: 'auth'
})

const route = useRoute()
const orgSlug = computed(() => route.params.orgSlug as string)
const toast = useToast()

const { data, pending, refresh } = await useFetch<AiOrgConfig>('/api/ai/org/config', {
  watch: [orgSlug],
  key: () => `org-ai-config-${orgSlug.value}`,
  default: (): AiOrgConfig => ({
    providers: [],
    modelListAvailable: false,
    catalog: [],
    enabled: [],
    hostEnabled: [],
    allowedModels: [],
    defaultModel: '',
    effectiveDefaultModel: '',
    features: [],
    embeddingAvailable: false,
    embeddingModels: [],
    embeddingModel: '',
    effectiveEmbeddingModel: '',
    embeddingStale: false,
    embeddingStoredModels: []
  })
})

const allowed = computed(() => data.value?.allowedModels ?? [])

function allowedOfKind(kind: AiModelKind) {
  return allowed.value.filter((m: AiModelInfo) => m.kind === kind)
}
const features = computed(() => data.value?.features ?? [])
const providers = computed(() => data.value?.providers ?? [])
const enabled = computed(() => data.value?.enabled ?? [])
const enabledIds = computed(() => enabled.value.map(m => m.id))

function ownKey(p: AiOrgProvider): boolean {
  return p.ownKey.status === 'ok'
}
function enabledOf(provider: AiProvider) {
  return enabled.value.filter(m => m.provider === provider)
}
function hostEnabledOf(provider: AiProvider) {
  return (data.value?.hostEnabled ?? []).filter((m: AiModelInfo) => m.provider === provider)
}
function addableOf(provider: AiProvider) {
  return (data.value?.catalog ?? []).filter((m: AiModelInfo) => m.provider === provider && !enabledIds.value.includes(m.id))
}

const activeProvider = ref<AiProvider>('openrouter')
const providerTabs = computed(() => providers.value.map(p => ({
  label: p.label,
  value: p.provider,
  icon: ownKey(p) ? 'i-lucide-key-round' : undefined
})))

const saving = ref(false)
const pendingAdd = ref('')

function fail(err: unknown, title: string) {
  toast.add({
    title,
    description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
    color: 'error'
  })
}

async function saveKey(provider: AiProvider, key: string): Promise<boolean> {
  saving.value = true
  try {
    await $fetch('/api/ai/org/key', { method: 'PUT', body: { provider, key } })
    await refresh()
    toast.add({ title: 'API key saved', color: 'success' })
    return true
  } catch (err: unknown) {
    fail(err, 'Key not saved')
    return false
  } finally {
    saving.value = false
  }
}

async function removeKey(provider: AiProvider) {
  saving.value = true
  try {
    await $fetch('/api/ai/org/key', { method: 'DELETE', query: { provider } })
    await refresh()
    toast.add({ title: 'API key removed', color: 'success' })
  } catch (err: unknown) {
    fail(err, 'Key not removed')
  } finally {
    saving.value = false
  }
}

async function put(body: Record<string, unknown>): Promise<boolean> {
  saving.value = true
  try {
    await $fetch('/api/ai/org/config', { method: 'PUT', body })
    await refresh()
    return true
  } catch (err: unknown) {
    fail(err, 'Update failed')
    return false
  } finally {
    saving.value = false
  }
}

async function addModel(id: string) {
  pendingAdd.value = ''
  if (!id || enabledIds.value.includes(id)) return
  if (await put({ enabled_models: [...enabledIds.value, id] })) {
    toast.add({ title: 'Model enabled', color: 'success' })
  }
}

async function removeModel(model: { id: string, name: string }) {
  // Drop the default and any feature choice that pointed at it.
  const featureMap: Record<string, string> = {}
  for (const f of features.value) {
    if (f.model && f.model !== model.id) featureMap[f.key] = f.model
  }
  const body: Record<string, unknown> = {
    enabled_models: enabledIds.value.filter(id => id !== model.id),
    feature_models: featureMap
  }
  if (data.value?.defaultModel === model.id) body.default_model = ''
  if (await put(body)) {
    toast.add({ title: `Disabled ${model.name}`, color: 'success' })
  }
}

async function setDefaultModel(id: string) {
  if (await put({ default_model: id })) {
    toast.add({ title: id ? 'Default model updated' : 'Using the host\'s default', color: 'success' })
  }
}

async function setFeatureModel(featureKey: string, id: string) {
  const map: Record<string, string> = {}
  for (const f of features.value) {
    if (f.model) map[f.key] = f.model
  }
  if (id) map[featureKey] = id
  else delete map[featureKey]
  if (await put({ feature_models: map })) {
    toast.add({ title: 'Feature model updated', color: 'success' })
  }
}

function nameOf(id: string): string {
  return allowed.value.find(m => m.id === id)?.name ?? id
}

// ---- Embedding model ----------------------------------------------------

const embeddingItems = computed<AiModelInfo[]>(() => (data.value?.embeddingModels ?? []).map((m: AiEmbeddingModelInfo): AiModelInfo => ({
  id: m.id,
  name: m.name,
  promptPrice: m.promptPrice,
  completionPrice: null,
  contextLength: m.contextLength,
  supportsTemperature: false,
  supportsCaching: false,
  provider: 'openrouter',
  kind: 'chat',
  supportsImages: false,
  requestPrice: null,
  reasoning: null
})))
function embeddingNameOf(id: string): string {
  return embeddingItems.value.find((m: AiModelInfo) => m.id === id)?.name ?? id
}
const confirmEmbedding = ref<string | null>(null)

async function setEmbeddingModel(id: string) {
  confirmEmbedding.value = null
  if (await put({ embedding_model: id })) {
    toast.add({ title: id ? 'Embedding model updated' : 'Using the host\'s embedding model', color: 'success' })
  }
}
function onPickEmbedding(id: string) {
  if (id === (data.value?.embeddingModel ?? '')) return
  if (data.value?.embeddingStoredModels.length) confirmEmbedding.value = id
  else setEmbeddingModel(id)
}

const reindex = ref<AiReindexStatus | null>(null)
const reindexing = computed(() => reindex.value?.running === true)
let reindexTimer: ReturnType<typeof setTimeout> | null = null
async function pollReindex() {
  try {
    reindex.value = await $fetch<AiReindexStatus>('/api/ai/org/reindex-status')
  } catch {
    return
  }
  if (reindex.value?.running) reindexTimer = setTimeout(pollReindex, 2000)
  else await refresh()
}
async function startReindex() {
  try {
    const res = await $fetch<{ started: boolean, reason: string | null, status: AiReindexStatus }>('/api/ai/org/reindex', { method: 'POST' })
    reindex.value = res.status
    if (!res.started) toast.add({ title: 'A rebuild is already running', color: 'warning' })
    await pollReindex()
  } catch (err: unknown) {
    fail(err, 'Could not start the rebuild')
  }
}
onBeforeUnmount(() => {
  if (reindexTimer) clearTimeout(reindexTimer)
})
</script>

<template>
  <div class="max-w-4xl mx-auto">
    <div class="space-y-8">
      <div>
        <h1 class="text-3xl font-bold">
          AI
        </h1>
        <p class="text-sm text-(--ui-text-muted) mt-1">
          Bring your own provider keys and choose which models power this
          organization's AI features.
        </p>
      </div>

      <div
        v-if="pending && !data"
        class="text-sm text-(--ui-text-muted)"
      >
        Loading...
      </div>

      <template v-else>
        <section class="space-y-3">
          <div>
            <h2 class="text-lg font-semibold">
              Providers
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              With your own key, you pick the provider's models and pay for them.
              Without one, you use the host's.
            </p>
          </div>

          <UTabs
            v-model="activeProvider"
            :items="providerTabs"
            variant="link"
            class="w-full"
            :ui="{ list: 'overflow-x-auto' }"
          >
            <template #content="{ item }">
              <div
                v-for="p in providers.filter(x => x.provider === item.value)"
                :key="p.provider"
                class="space-y-3 pt-2"
              >
                <AiProviderKey
                  :provider="p.provider"
                  :label="p.label"
                  :status="p.ownKey.status"
                  :last4="p.ownKey.last4"
                  :disabled="saving"
                  :empty-hint="p.hostKey ? 'Using the host\'s key and models.' : 'Add one to use these models.'"
                  :save="(key: string) => saveKey(p.provider, key)"
                  @remove="removeKey(p.provider)"
                />

                <template v-if="ownKey(p)">
                  <UAlert
                    v-if="!p.catalogAvailable"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-cloud-off"
                    title="Model list unavailable"
                    description="Existing choices still work."
                  />
                  <AiModelList
                    v-if="enabledOf(p.provider).length"
                    :models="enabledOf(p.provider)"
                    removable
                    :disabled="saving"
                    @remove="removeModel"
                  />
                  <p
                    v-else
                    class="text-sm text-(--ui-text-muted)"
                  >
                    No {{ p.label }} models enabled.
                  </p>
                  <div class="max-w-md">
                    <AiModelSelect
                      :model-value="pendingAdd"
                      :items="addableOf(p.provider)"
                      placeholder="Add a model…"
                      :disabled="saving || !addableOf(p.provider).length"
                      @update:model-value="addModel"
                    />
                  </div>
                </template>

                <template v-else-if="p.hostKey && p.ownKey.status === 'none'">
                  <AiModelList
                    v-if="hostEnabledOf(p.provider).length"
                    :models="hostEnabledOf(p.provider)"
                  />
                  <p
                    v-else
                    class="text-sm text-(--ui-text-muted)"
                  >
                    The host hasn't enabled any {{ p.label }} models.
                  </p>
                </template>
              </div>
            </template>
          </UTabs>
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-lg font-semibold">
              Default model
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Used by any feature without its own choice below.
              <template v-if="!data?.defaultModel && data?.effectiveDefaultModel">
                Currently the host's: {{ nameOf(data.effectiveDefaultModel) }}.
              </template>
              <template v-else-if="!data?.effectiveDefaultModel">
                Nothing resolves yet — choose one here or ask the host to set a default.
              </template>
            </p>
          </div>

          <UAlert
            v-if="!data?.modelListAvailable"
            color="warning"
            variant="subtle"
            icon="i-lucide-cloud-off"
            title="Model list unavailable"
            description="Existing choices still work."
          />

          <div class="max-w-md">
            <AiModelSelect
              :model-value="data?.defaultModel ?? ''"
              :items="allowedOfKind('chat')"
              clearable
              clear-label="Use the host's default"
              :disabled="saving || !allowedOfKind('chat').length"
              @update:model-value="setDefaultModel"
            />
          </div>
        </section>

        <section
          v-if="features.length"
          class="space-y-3"
        >
          <div>
            <h2 class="text-lg font-semibold">
              Feature models
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Override the model behind each AI feature for this organization.
            </p>
          </div>

          <ul class="divide-y divide-(--ui-border) border border-(--ui-border) rounded-md">
            <li
              v-for="feature in features"
              :key="feature.key"
              class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4"
            >
              <div class="min-w-0">
                <div class="font-medium">
                  {{ feature.label }}
                </div>
                <div
                  v-if="feature.description"
                  class="text-xs text-(--ui-text-muted)"
                >
                  {{ feature.description }}
                </div>
                <div class="text-xs text-(--ui-text-muted) mt-1">
                  <template v-if="feature.effectiveModel">
                    Runs on {{ nameOf(feature.effectiveModel) }}
                  </template>
                  <template v-else>
                    No model resolves for this feature yet.
                  </template>
                </div>
              </div>
              <div class="w-full sm:w-72 shrink-0">
                <AiModelSelect
                  :model-value="feature.model"
                  :items="allowedOfKind(feature.kind)"
                  clearable
                  clear-label="Use default"
                  :disabled="saving || !allowedOfKind(feature.kind).length"
                  @update:model-value="(v: string) => setFeatureModel(feature.key, v)"
                />
              </div>
            </li>
          </ul>
        </section>

        <section
          v-if="data?.embeddingAvailable"
          class="space-y-3"
        >
          <div>
            <h2 class="text-lg font-semibold">
              Embedding model
            </h2>
            <p class="text-sm text-(--ui-text-muted)">
              Builds this organization's search indexes (help libraries, portfolio sections).
              <template v-if="!data?.embeddingModel && data?.effectiveEmbeddingModel">
                Currently the host's: {{ embeddingNameOf(data.effectiveEmbeddingModel) }}.
              </template>
              <template v-else-if="!data?.effectiveEmbeddingModel">
                Nothing resolves yet — search stays off until one is chosen here or by the host.
              </template>
            </p>
          </div>

          <div class="max-w-md">
            <AiModelSelect
              :model-value="data?.embeddingModel ?? ''"
              :items="embeddingItems"
              clearable
              clear-label="Use the host's embedding model"
              :disabled="saving || reindexing || !embeddingItems.length"
              @update:model-value="onPickEmbedding"
            />
          </div>

          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Changing this makes the existing search indexes unusable until they are rebuilt"
            description="Vectors from different models cannot be compared. After a change, re-embed this organization's indexes with the button that appears below."
          />

          <UAlert
            v-if="data?.embeddingStale && !reindexing"
            color="error"
            variant="subtle"
            icon="i-lucide-database-zap"
            title="The search indexes were built with another model"
          >
            <template #description>
              <p class="mb-2">
                Search returns nothing useful until they are rebuilt with {{ embeddingNameOf(data.effectiveEmbeddingModel) }}.
              </p>
              <UButton
                size="sm"
                color="error"
                icon="i-lucide-refresh-cw"
                :disabled="saving"
                @click="startReindex"
              >
                Re-embed this organization's indexes
              </UButton>
            </template>
          </UAlert>

          <div
            v-if="reindex"
            class="text-sm border border-(--ui-border) rounded-md p-3 flex items-center gap-2"
          >
            <UIcon
              :name="reindexing ? 'i-lucide-loader-circle' : 'i-lucide-check'"
              class="size-4"
              :class="{ 'animate-spin': reindexing }"
            />
            <span v-if="reindexing">
              Rebuilding{{ reindex.scopes[0]?.current ? ` ${reindex.scopes[0].current}` : '' }}…
              {{ reindex.scopes[0]?.items ?? 0 }} of {{ reindex.scopes[0]?.total ?? 0 }} items,
              {{ reindex.scopes[0]?.chunks ?? 0 }} chunks
            </span>
            <span v-else>
              Rebuild finished — {{ reindex.scopes.reduce((n, s) => n + s.chunks, 0) }} chunks
              <span
                v-if="reindex.scopes.some(s => s.error)"
                class="text-(--ui-error)"
              >({{ reindex.scopes.find(s => s.error)?.error }})</span>
            </span>
          </div>
        </section>
      </template>
    </div>

    <UModal
      :open="confirmEmbedding !== null"
      title="Change the embedding model?"
      @update:open="(v: boolean) => { if (!v) confirmEmbedding = null }"
    >
      <template #body>
        <p class="text-sm">
          This organization's search indexes stop matching until they are re-embedded.
          You can start the rebuild right after saving.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            variant="ghost"
            color="neutral"
            @click="confirmEmbedding = null"
          >
            Cancel
          </UButton>
          <UButton
            color="warning"
            @click="setEmbeddingModel(confirmEmbedding ?? '')"
          >
            Change model
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
