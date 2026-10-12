<script setup lang="ts">
import type { AiAdminConfig, AiEnabledModel, AiHostProvider, AiModelInfo, AiModelKind, AiProvider, AiEmbeddingModelInfo, AiReindexStatus, AiStaleScope } from '#ai'

definePageMeta({
  layout: 'admin',
  middleware: ['auth', 'admin']
})

const toast = useToast()

const { data, pending, refresh } = await useFetch<AiAdminConfig>('/api/ai/admin/config', {
  default: (): AiAdminConfig => ({
    providers: [], modelListAvailable: false, catalog: [], enabled: [], defaultModel: '', features: [],
    embeddingAvailable: false, embeddingModelListAvailable: false, embeddingModel: '', staleScopes: []
  })
})
const { data: embeddingList } = await useFetch<{ models: AiEmbeddingModelInfo[] }>('/api/ai/embedding-models', {
  default: () => ({ models: [] })
})

const enabled = computed(() => data.value?.enabled ?? [])
const features = computed(() => data.value?.features ?? [])
const enabledIds = computed(() => enabled.value.map(m => m.id))
const providers = computed(() => data.value?.providers ?? [])

function hasKey(p: AiHostProvider): boolean {
  return p.keySource === 'env' || p.storedKey.status === 'ok'
}

// Default and feature pickers offer only models a host key can pay for.
const keyedProviders = computed(() => new Set(providers.value.filter(hasKey).map(p => p.provider)))
function enabledOfKind(kind: AiModelKind) {
  return enabled.value.filter((m: AiEnabledModel) => m.kind === kind && keyedProviders.value.has(m.provider))
}

function enabledOf(provider: AiProvider) {
  return enabled.value.filter((m: AiEnabledModel) => m.provider === provider)
}

// A provider's models still addable: everything it lists that isn't enabled yet.
function addableOf(provider: AiProvider) {
  return (data.value?.catalog ?? []).filter((m: AiModelInfo) => m.provider === provider && !enabledIds.value.includes(m.id))
}

const activeProvider = ref<AiProvider>('openrouter')
const providerTabs = computed(() => providers.value.map(p => ({
  label: p.label,
  value: p.provider,
  icon: hasKey(p) ? 'i-lucide-key-round' : undefined
})))

const saving = ref(false)
const pendingAdd = ref('')

function errorMessage(err: unknown): string | undefined {
  return (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage
}

async function saveHostKey(provider: AiProvider, key: string): Promise<boolean> {
  saving.value = true
  try {
    await $fetch('/api/ai/admin/key', { method: 'PUT', body: { provider, key } })
    await refresh()
    toast.add({ title: 'API key saved', color: 'success' })
    return true
  } catch (err: unknown) {
    toast.add({ title: 'Key not saved', description: errorMessage(err), color: 'error' })
    return false
  } finally {
    saving.value = false
  }
}

async function removeHostKey(provider: AiProvider) {
  saving.value = true
  try {
    await $fetch('/api/ai/admin/key', { method: 'DELETE', query: { provider } })
    await refresh()
    toast.add({ title: 'API key removed', color: 'success' })
  } catch (err: unknown) {
    toast.add({ title: 'Key not removed', description: errorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function put(body: Record<string, unknown>): Promise<boolean> {
  saving.value = true
  try {
    await $fetch('/api/ai/admin/config', { method: 'PUT', body })
    await refresh()
    return true
  } catch (err: unknown) {
    toast.add({
      title: 'Update failed',
      description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage,
      color: 'error'
    })
    return false
  } finally {
    saving.value = false
  }
}

async function addModel(id: string) {
  pendingAdd.value = ''
  if (!id || enabledIds.value.includes(id)) return
  if (await put({ enabled_models: [...enabledIds.value, id] })) {
    toast.add({ title: `Enabled ${id}`, color: 'success' })
  }
}

async function removeModel(model: { id: string, name: string }) {
  const next = enabledIds.value.filter(id => id !== model.id)
  // Drop the default and any feature choice that pointed at it.
  const featureMap: Record<string, string> = {}
  for (const f of features.value) {
    if (f.model && f.model !== model.id) featureMap[f.key] = f.model
  }
  const body: Record<string, unknown> = { enabled_models: next, feature_models: featureMap }
  if (data.value?.defaultModel === model.id) body.default_model = ''
  if (await put(body)) {
    toast.add({ title: `Disabled ${model.name}`, color: 'success' })
  }
}

async function setDefaultModel(id: string) {
  if (await put({ default_model: id })) {
    toast.add({ title: id ? 'Default model updated' : 'Default model cleared', color: 'success' })
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
  return enabled.value.find(m => m.id === id)?.name ?? id
}

// ---- Embedding model ----------------------------------------------------

// The picker reuses AiModelSelect, which renders AiModelInfo rows; embedding
// models carry a subset of those fields.
const embeddingItems = computed<AiModelInfo[]>(() => (embeddingList.value?.models ?? []).map((m: AiEmbeddingModelInfo): AiModelInfo => ({
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
const staleScopes = computed<AiStaleScope[]>(() => data.value?.staleScopes ?? [])
const confirmEmbedding = ref<string | null>(null)

async function setEmbeddingModel(id: string) {
  confirmEmbedding.value = null
  if (await put({ embedding_model: id })) {
    toast.add({ title: id ? 'Embedding model updated' : 'Embedding model cleared', color: 'success' })
  }
}
function onPickEmbedding(id: string) {
  if (id === (data.value?.embeddingModel ?? '')) return
  // Only warn when an index exists somewhere that this change would orphan.
  if (data.value?.embeddingModel || staleScopes.value.length) confirmEmbedding.value = id
  else setEmbeddingModel(id)
}

const reindex = ref<AiReindexStatus | null>(null)
const reindexing = computed(() => reindex.value?.running === true)
let reindexTimer: ReturnType<typeof setTimeout> | null = null
async function pollReindex() {
  try {
    reindex.value = await $fetch<AiReindexStatus>('/api/ai/admin/reindex-status')
  } catch {
    return
  }
  if (reindex.value?.running) reindexTimer = setTimeout(pollReindex, 2000)
  else await refresh()
}
async function startReindex(all = false) {
  try {
    const res = await $fetch<{ started: boolean, reason: string | null, status: AiReindexStatus }>('/api/ai/admin/reindex', { method: 'POST', body: { all } })
    reindex.value = res.status
    if (!res.started && res.reason === 'already-running') toast.add({ title: 'A rebuild is already running', color: 'warning' })
    await pollReindex()
  } catch (err: unknown) {
    toast.add({ title: 'Could not start the rebuild', description: (err as { data?: { statusMessage?: string } } | null)?.data?.statusMessage, color: 'error' })
  }
}
onBeforeUnmount(() => {
  if (reindexTimer) clearTimeout(reindexTimer)
})
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-bold">
        AI
      </h1>
      <p class="text-sm text-(--ui-text-muted)">
        Models the host's keys can run, the default, and the model for each
        feature. Organizations inherit these and can override them.
      </p>
    </header>

    <UAlert
      v-if="providers.length && !keyedProviders.size"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No host API key"
      description="Add a key below so organizations without their own have a fallback."
    />

    <section class="space-y-3">
      <div>
        <h2 class="text-lg font-semibold">
          Providers
        </h2>
        <p class="text-sm text-(--ui-text-muted)">
          Add a provider's key, then enable the models it may run.
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
              :status="p.storedKey.status"
              :last4="p.storedKey.last4"
              :env-var="p.keySource === 'env' ? p.envVar : ''"
              :disabled="saving"
              :empty-hint="`Add one, or set ${p.envVar}.`"
              :save="(key: string) => saveHostKey(p.provider, key)"
              @remove="removeHostKey(p.provider)"
            />

            <template v-if="hasKey(p) || enabledOf(p.provider).length">
              <p
                v-if="!hasKey(p)"
                class="text-sm text-(--ui-text-muted)"
              >
                These models won't run until a key is added.
              </p>
              <UAlert
                v-else-if="!p.catalogAvailable"
                color="warning"
                variant="subtle"
                icon="i-lucide-cloud-off"
                title="Model list unavailable"
                description="Existing choices still work. You can add models once the list loads."
              />

              <AiModelList
                v-if="enabledOf(p.provider).length"
                :models="enabledOf(p.provider)"
                removable
                :disabled="saving"
                @remove="removeModel"
              />
              <p
                v-else-if="!pending"
                class="text-sm text-(--ui-text-muted)"
              >
                No {{ p.label }} models enabled.
              </p>

              <div
                v-if="hasKey(p)"
                class="max-w-md"
              >
                <AiModelSelect
                  :model-value="pendingAdd"
                  :items="addableOf(p.provider)"
                  placeholder="Add a model…"
                  :disabled="saving || !addableOf(p.provider).length"
                  @update:model-value="addModel"
                />
              </div>
            </template>
          </div>
        </template>
      </UTabs>

      <p
        v-if="!enabled.length && !pending"
        class="text-sm text-(--ui-text-muted)"
      >
        AI stays off until a model is enabled and set as default.
      </p>
    </section>

    <section class="space-y-3">
      <div>
        <h2 class="text-lg font-semibold">
          Default model
        </h2>
        <p class="text-sm text-(--ui-text-muted)">
          Used by chat features without their own model.
        </p>
      </div>
      <div class="max-w-md">
        <AiModelSelect
          :model-value="data?.defaultModel ?? ''"
          :items="enabledOfKind('chat')"
          clearable
          clear-label="None"
          :disabled="saving || !enabledOfKind('chat').length"
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
          Override the model for a specific feature.
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
                No model resolves — enable a model and choose a default.
              </template>
            </div>
          </div>
          <div class="w-full sm:w-72 shrink-0">
            <AiModelSelect
              :model-value="feature.model"
              :items="enabledOfKind(feature.kind)"
              clearable
              :clear-label="feature.kind === 'chat' ? 'Use default' : 'None'"
              :disabled="saving || !enabledOfKind(feature.kind).length"
              @update:model-value="(v: string) => setFeatureModel(feature.key, v)"
            />
          </div>
        </li>
      </ul>
    </section>

    <div
      v-else-if="!pending"
      class="text-sm text-(--ui-text-muted)"
    >
      No AI features are registered yet.
    </div>

    <section
      v-if="data?.embeddingAvailable"
      class="space-y-3"
    >
      <div>
        <h2 class="text-lg font-semibold">
          Embedding model
        </h2>
        <p class="text-sm text-(--ui-text-muted)">
          Builds the search indexes. Organizations can pick their own.
        </p>
      </div>

      <UAlert
        v-if="!data?.embeddingModelListAvailable"
        color="warning"
        variant="subtle"
        icon="i-lucide-cloud-off"
        title="Embedding model list unavailable"
        description="The current choice still works."
      />

      <div class="max-w-md">
        <AiModelSelect
          :model-value="data?.embeddingModel ?? ''"
          :items="embeddingItems"
          clearable
          clear-label="None"
          :disabled="saving || reindexing || !embeddingItems.length"
          @update:model-value="onPickEmbedding"
        />
      </div>

      <UAlert
        v-if="staleScopes.length && !reindexing"
        color="error"
        variant="subtle"
        icon="i-lucide-database-zap"
        :title="`${staleScopes.length} ${staleScopes.length === 1 ? 'index set was' : 'index sets were'} built with another model`"
      >
        <template #description>
          <p class="mb-2">
            Search won't work for these until they're rebuilt.
          </p>
          <UButton
            size="sm"
            color="error"
            icon="i-lucide-refresh-cw"
            :disabled="saving"
            @click="startReindex(false)"
          >
            Re-embed the affected indexes
          </UButton>
        </template>
      </UAlert>

      <div
        v-if="reindex"
        class="text-sm border border-(--ui-border) rounded-md p-3 space-y-1"
      >
        <div class="font-medium flex items-center gap-2">
          <UIcon
            :name="reindexing ? 'i-lucide-loader-circle' : 'i-lucide-check'"
            class="size-4"
            :class="{ 'animate-spin': reindexing }"
          />
          {{ reindexing ? 'Rebuilding…' : 'Rebuild finished' }}
        </div>
        <ul class="text-xs text-(--ui-text-muted)">
          <li
            v-for="scope in reindex.scopes"
            :key="scope.orgId ?? 'single'"
          >
            {{ scope.orgId ?? 'this deployment' }} — {{ scope.state }}<template v-if="scope.current">
              ({{ scope.current }})</template>: {{ scope.items }} of {{ scope.total }} items, {{ scope.chunks }} chunks
            <span
              v-if="scope.error"
              class="text-(--ui-error)"
            >({{ scope.error }})</span>
          </li>
        </ul>
      </div>

      <UButton
        v-if="data?.embeddingModel && !reindexing"
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-refresh-cw"
        @click="startReindex(true)"
      >
        Re-embed everything
      </UButton>
    </section>

    <UModal
      :open="confirmEmbedding !== null"
      title="Change the embedding model?"
      @update:open="(v: boolean) => { if (!v) confirmEmbedding = null }"
    >
      <template #body>
        <p class="text-sm">
          Existing search indexes stop working until they're re-embedded.
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
