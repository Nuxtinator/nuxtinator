<script setup lang="ts">
// Create / edit one widget, plus the embed helper: the snippet to paste into
// the site, optional CSS variables to match the site's styling, and a live
// preview of the saved widget running on this page.
import type { HelpinatorWidget, HelpinatorPortfolioOption, HelpinatorAppearanceForm, HelpinatorLibrarySummary } from '../../../utils/helpinator-types'
import { helpinatorErrorMessage } from '../../../utils/helpinator-types'
import type { AiModelInfo } from '#ai'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const pathTo = useHelpinatorPath()
const toast = useToast()
const isNew = computed(() => route.params.id === 'new')

const { data: status } = useHelpinatorStatus()
const { data: portfolios } = useFetch<HelpinatorPortfolioOption[]>('/api/helpinator/portfolios', { default: () => [] })
const { data: libraries } = useFetch<HelpinatorLibrarySummary[]>('/api/helpinator/libraries', { default: () => [] })
const { data: modelChoice } = useFetch<{ models: AiModelInfo[], defaultModel: string }>('/api/helpinator/models', {
  default: () => ({ models: [], defaultModel: '' })
})

// The server's defaults (one source of truth). The form shows them filled in
// and saves only the fields that differ, so untouched fields keep following
// the defaults.
const defaults = computed<HelpinatorAppearanceForm | null>(() => saved.value?.appearance_defaults ?? status.value?.appearanceDefaults ?? null)

const form = reactive({
  name: '',
  library_ids: [] as string[],
  default_library_id: '' as string,
  default_section_key: '',
  originsText: '',
  daily_message_cap: 500,
  enabled: true,
  appearance: {} as HelpinatorAppearanceForm,
  extra_instructions: '',
  starter_questions: [] as string[],
  // '' = the org's choice.
  chat_model: ''
})
const saved = ref<HelpinatorWidget | null>(null)
const saving = ref(false)
const confirmDelete = ref(false)
const previewKey = ref(0)

function fill(w: HelpinatorWidget) {
  saved.value = w
  form.name = w.name
  form.library_ids = [...w.library_ids]
  form.default_library_id = w.default_library_id ?? ''
  form.default_section_key = w.default_section_key ?? ''
  form.originsText = w.allowed_origins.join('\n')
  form.daily_message_cap = w.daily_message_cap
  form.enabled = w.enabled
  form.appearance = { ...w.appearance_defaults, ...w.appearance }
  form.extra_instructions = w.extra_instructions
  form.starter_questions = [...w.starter_questions]
  form.chat_model = w.chat_model ?? ''
}

if (!isNew.value) {
  const { data, error } = await useFetch<HelpinatorWidget>(`/api/helpinator/widgets/${route.params.id}`)
  if (error.value) throw createError({ statusCode: error.value.statusCode ?? 404, statusMessage: 'Widget not found', fatal: true })
  if (data.value) fill(data.value)
}

const libraryItems = computed(() => (libraries.value ?? []).map((l: HelpinatorLibrarySummary) => ({
  label: `${l.name} (${l.kind})`,
  value: l.id
})))
const defaultItems = computed(() => libraryItems.value.filter((i: { label: string, value: string }) => form.library_ids.includes(i.value)))
const defaultLibrary = computed(() => libraries.value?.find((l: HelpinatorLibrarySummary) => l.id === form.default_library_id) ?? null)
// The default section only applies when the default library is a portfolio.
const defaultPortfolio = computed(() => defaultLibrary.value?.kind === 'portfolio'
  ? portfolios.value?.find((p: HelpinatorPortfolioOption) => p.id === defaultLibrary.value?.portfolio_id) ?? null
  : null)
const sectionItems = computed(() => (defaultPortfolio.value?.sections ?? []).map((s: HelpinatorPortfolioOption['sections'][number]) => ({ label: s.title, value: s.key })))
const orgDefaultLabel = computed(() => {
  const id = modelChoice.value.defaultModel
  if (!id) return 'Organization default (none set)'
  return `Organization default (${modelChoice.value.models.find((m: AiModelInfo) => m.id === id)?.name ?? id})`
})
// Saved pick the org can no longer use, still selected in the form.
const modelFallingBack = computed(() => Boolean(saved.value?.chat_model_unavailable) && form.chat_model === saved.value?.chat_model)
const positionItems = [
  { label: 'Bottom right', value: 'bottom-right' },
  { label: 'Bottom left', value: 'bottom-left' }
]

watch(() => form.library_ids, (ids) => {
  if (!ids.includes(form.default_library_id)) form.default_library_id = ids[0] ?? ''
})
watch(defaultPortfolio, (p) => {
  if (!p) {
    form.default_section_key = ''
  } else if (!p.sections.some((s: HelpinatorPortfolioOption['sections'][number]) => s.key === form.default_section_key)) {
    form.default_section_key = p.sections[0]?.key ?? ''
  }
})

// Matches HELPINATOR_MAX_STARTER_QUESTIONS on the server.
const MAX_STARTER_QUESTIONS = 6
function addStarterQuestion() {
  if (form.starter_questions.length < MAX_STARTER_QUESTIONS) form.starter_questions.push('')
}

const rebinding = computed(() => {
  if (!saved.value) return false
  const a = [...saved.value.library_ids].sort().join(',')
  const b = [...form.library_ids].sort().join(',')
  return a !== b || (saved.value.default_library_id ?? '') !== form.default_library_id
})

function appearanceOverrides(): Partial<HelpinatorAppearanceForm> {
  const base = defaults.value
  if (!base) return {}
  const out: Partial<HelpinatorAppearanceForm> = {}
  for (const k of Object.keys(form.appearance) as (keyof HelpinatorAppearanceForm)[]) {
    const v = form.appearance[k]
    if (v && v !== base[k]) (out as Record<string, string>)[k] = v
  }
  return out
}

// A new widget starts from the defaults once the status call returns them.
watch(defaults, (d) => {
  if (d && Object.keys(form.appearance).length === 0) form.appearance = { ...d }
}, { immediate: true })

async function save() {
  saving.value = true
  try {
    const body = {
      name: form.name,
      library_ids: form.library_ids,
      default_library_id: form.default_library_id,
      default_section_key: defaultPortfolio.value ? form.default_section_key || null : null,
      allowed_origins: form.originsText.split('\n').map(s => s.trim()).filter(Boolean),
      daily_message_cap: Number(form.daily_message_cap),
      enabled: form.enabled,
      appearance: appearanceOverrides(),
      extra_instructions: form.extra_instructions,
      starter_questions: form.starter_questions.map(q => q.trim()).filter(Boolean),
      chat_model: form.chat_model || null
    }
    const w = isNew.value
      ? await $fetch<HelpinatorWidget>('/api/helpinator/widgets', { method: 'POST', body })
      : await $fetch<HelpinatorWidget>(`/api/helpinator/widgets/${saved.value!.id}`, { method: 'PUT', body })
    fill(w)
    previewKey.value++
    refreshNuxtData('helpinator-sidebar-widgets') // name / enabled show in the sidebar
    toast.add({ title: 'Widget saved', color: 'success' })
    if (isNew.value) await navigateTo(pathTo(`/helpinator/widgets/${w.id}`), { replace: true })
  } catch (err) {
    toast.add({ title: 'Could not save', description: helpinatorErrorMessage(err), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function remove() {
  try {
    await $fetch(`/api/helpinator/widgets/${saved.value!.id}`, { method: 'DELETE' })
    refreshNuxtData('helpinator-sidebar-widgets')
    await navigateTo(pathTo('/helpinator/widgets'))
  } catch (err) {
    toast.add({ title: 'Could not delete', description: helpinatorErrorMessage(err), color: 'error' })
  }
}

// ---- Embed helper -------------------------------------------------------

const hostOrigin = computed(() => import.meta.client ? window.location.origin : '')
// Script tags are split with `${'script'}` so neither the SFC parser nor Nuxt's
// regex-based build plugins read them as a script block boundary.
const snippet = computed(() => saved.value
  ? `<${'script'} src="${hostOrigin.value}/js/helpinator-widget.iife.js" defer></${'script'}>\n<helpinator-widget host="${hostOrigin.value}" widget-id="${saved.value.id}"></helpinator-widget>`
  : '')
const cssSnippet = computed(() => `<style>
  /* Optional — match this site's styling. Every variable is optional. */
  helpinator-widget {
    --helpinator-primary: ${form.appearance.primary_color};
    --helpinator-on-primary: #ffffff;
    --helpinator-font: inherit;
    --helpinator-radius: 14px;
    --helpinator-offset-x: 20px;
    --helpinator-offset-y: 20px;
  }
</style>`)

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: 'Copied', color: 'success' })
  } catch {
    toast.add({ title: 'Copy failed — select the text and copy it manually', color: 'warning' })
  }
}

// Live preview: the real bundle, running against this host (same-origin is
// always allowed). Only for a saved widget; remounts after each save.
const previewOn = ref(false)
function ensureBundle(): Promise<void> {
  if (customElements.get('helpinator-widget')) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/js/helpinator-widget.iife.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load the widget bundle'))
    document.head.appendChild(s)
  })
}
async function togglePreview() {
  if (!previewOn.value) {
    try {
      await ensureBundle()
    } catch (err) {
      toast.add({ title: helpinatorErrorMessage(err), color: 'error' })
      return
    }
  }
  previewOn.value = !previewOn.value
}
</script>

<template>
  <HelpinatorShell :title="isNew ? 'New widget' : form.name || 'Widget'">
    <div class="max-w-5xl mx-auto space-y-6">
      <UButton
        :to="pathTo('/helpinator/widgets')"
        icon="i-lucide-arrow-left"
        variant="ghost"
        color="neutral"
        size="sm"
      >
        All widgets
      </UButton>

      <UAlert
        v-if="status && !status.canManage"
        color="warning"
        variant="subtle"
        title="You don't have permission to manage widgets."
      />

      <form v-else class="grid gap-6 lg:grid-cols-2" @submit.prevent="save">
        <UCard>
          <template #header>
            <h2 class="font-semibold">
              Setup
            </h2>
          </template>
          <div class="space-y-4">
            <UFormField label="Name" help="For your own reference, e.g. the site's name." required>
              <UInput v-model="form.name" class="w-full" />
            </UFormField>

            <UFormField
              label="Libraries"
              help="The ONLY content this widget's assistant can search and read. Treat everything in them as public — visitors can get the assistant to reveal any of it."
              required
            >
              <USelectMenu v-model="form.library_ids" :items="libraryItems" value-key="value" multiple placeholder="Choose libraries" class="w-full" />
              <p v-if="libraryItems.length === 0" class="text-xs text-(--ui-text-muted) mt-1">
                No libraries yet —
                <NuxtLink :to="pathTo('/helpinator/libraries/new')" class="underline">create one</NuxtLink> first.
              </p>
            </UFormField>

            <UFormField label="Default library" help="Its page index is part of every chat; the other libraries are reached through search." required>
              <USelect v-model="form.default_library_id" :items="defaultItems" :disabled="!form.library_ids.length" class="w-full" />
            </UFormField>
            <UAlert
              v-if="rebinding"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Changing the libraries ends this widget's open conversations."
            />

            <UFormField v-if="defaultPortfolio" label="Default section" help="Loaded into every chat — pick the one most relevant to this site. The assistant can read the rest when needed.">
              <USelect v-model="form.default_section_key" :items="sectionItems" class="w-full" />
            </UFormField>

            <UFormField label="Allowed sites" help="One origin per line, e.g. https://www.example.org. Use https://*.example.org for every subdomain (the bare domain needs its own line). Localhost works in development without being listed.">
              <UTextarea v-model="form.originsText" :rows="3" class="w-full font-mono text-xs" placeholder="https://www.example.org" />
            </UFormField>

            <UFormField label="AI model" help="The model that answers on this widget. Choose from the models your organization has enabled.">
              <AiModelSelect v-model="form.chat_model" :items="modelChoice.models" clearable :clear-label="orgDefaultLabel" class="w-full" />
            </UFormField>
            <UAlert
              v-if="modelFallingBack"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="This model is no longer available to your organization."
              description="Until you choose another, this widget answers with the organization default."
            />

            <UFormField label="Daily message limit" help="Visitor messages per 24 hours across all conversations on this widget. Protects your AI budget.">
              <UInput v-model.number="form.daily_message_cap" type="number" :min="1" class="w-40" />
            </UFormField>

            <UFormField label="Extra instructions" help="Optional guidance for the assistant (tone, what to avoid, when to suggest a human). Visitors can extract this text, so don't put secrets here.">
              <UTextarea v-model="form.extra_instructions" :rows="4" :maxlength="4000" class="w-full" />
            </UFormField>

            <USwitch v-model="form.enabled" label="Widget is live" />
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="font-semibold">
              Appearance
            </h2>
          </template>
          <div class="space-y-4">
            <UFormField label="Colour">
              <div class="flex items-center gap-2">
                <input v-model="form.appearance.primary_color" type="color" class="h-9 w-12 rounded border border-(--ui-border) bg-transparent">
                <UInput v-model="form.appearance.primary_color" class="w-32 font-mono" />
              </div>
            </UFormField>
            <UFormField label="Position">
              <USelect v-model="form.appearance.position" :items="positionItems" class="w-48" />
            </UFormField>
            <UFormField label="Title">
              <UInput v-model="form.appearance.title" :maxlength="80" class="w-full" />
            </UFormField>
            <UFormField label="Greeting" help="The first message visitors see. Markdown allowed.">
              <UTextarea v-model="form.appearance.greeting" :rows="2" :maxlength="500" class="w-full" />
            </UFormField>
            <UFormField label="Suggested questions" help="Shown under the greeting as buttons visitors can click to ask. They disappear once the visitor sends a message.">
              <div class="space-y-2">
                <div v-for="(_, i) in form.starter_questions" :key="i" class="flex items-center gap-2">
                  <UInput v-model="form.starter_questions[i]" :maxlength="200" class="flex-1" placeholder="e.g. What are your opening hours?" />
                  <UButton
                    icon="i-lucide-x"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    aria-label="Remove question"
                    @click="form.starter_questions.splice(i, 1)"
                  />
                </div>
                <UButton
                  v-if="form.starter_questions.length < MAX_STARTER_QUESTIONS"
                  icon="i-lucide-plus"
                  variant="outline"
                  color="neutral"
                  size="sm"
                  @click="addStarterQuestion"
                >
                  Add question
                </UButton>
              </div>
            </UFormField>
            <UFormField label="Input placeholder">
              <UInput v-model="form.appearance.placeholder" :maxlength="120" class="w-full" />
            </UFormField>
            <UFormField label="'Still need help?' prompt" help="Shown when a visitor asks for a person.">
              <UTextarea v-model="form.appearance.handoff_prompt" :rows="2" :maxlength="500" class="w-full" />
            </UFormField>
          </div>
        </UCard>

        <div class="lg:col-span-2 flex items-center gap-2">
          <UButton type="submit" :loading="saving">
            {{ isNew ? 'Create widget' : 'Save' }}
          </UButton>
          <div class="flex-1" />
          <UButton v-if="!isNew" color="error" variant="ghost" icon="i-lucide-trash-2" @click="confirmDelete = true">
            Delete
          </UButton>
        </div>
      </form>

      <UCard v-if="saved">
        <template #header>
          <div class="flex items-center gap-2">
            <h2 class="font-semibold flex-1">
              Add it to your site
            </h2>
            <UButton size="sm" variant="outline" color="neutral" :icon="previewOn ? 'i-lucide-eye-off' : 'i-lucide-eye'" @click="togglePreview">
              {{ previewOn ? 'Hide preview' : 'Preview on this page' }}
            </UButton>
          </div>
        </template>
        <div class="space-y-5">
          <div class="space-y-2">
            <p class="text-sm">
              1. Paste this just before <code>&lt;/body&gt;</code> on every page that should show the help chat.
            </p>
            <div class="relative">
              <pre class="text-xs bg-(--ui-bg-elevated) rounded-lg p-3 pr-12 overflow-x-auto whitespace-pre-wrap break-all">{{ snippet }}</pre>
              <UButton class="absolute top-2 right-2" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" aria-label="Copy snippet" @click="copy(snippet)" />
            </div>
          </div>
          <div class="space-y-2">
            <p class="text-sm">
              2. Make sure the site's address is in <strong>Allowed sites</strong> above
              <span v-if="!saved.allowed_origins.length" class="text-(--ui-warning)">(none yet — the widget won't load anywhere else)</span>.
            </p>
          </div>
          <div class="space-y-2">
            <p class="text-sm">
              3. Optional: match the site's look. These CSS variables override the colour set above on that site only.
            </p>
            <div class="relative">
              <pre class="text-xs bg-(--ui-bg-elevated) rounded-lg p-3 pr-12 overflow-x-auto">{{ cssSnippet }}</pre>
              <UButton class="absolute top-2 right-2" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" aria-label="Copy CSS" @click="copy(cssSnippet)" />
            </div>
            <p class="text-xs text-(--ui-text-muted)">
              Also available: <code>--helpinator-bg</code>, <code>--helpinator-text</code>, <code>--helpinator-muted</code>,
              <code>--helpinator-border</code>, <code>--helpinator-bot-bubble</code>, <code>--helpinator-user-bubble</code>,
              <code>--helpinator-width</code>, <code>--helpinator-height</code>, <code>--helpinator-z-index</code>, and <code>::part()</code> selectors
              (<code>launcher</code>, <code>panel</code>, <code>header</code>, <code>message</code>, <code>user-message</code>,
              <code>bot-message</code>, <code>starters</code>, <code>starter</code>, <code>composer</code>, <code>send</code>, <code>form</code>, <code>banner</code>).
            </p>
          </div>
          <p v-if="previewOn" class="text-xs text-(--ui-text-muted)">
            The preview is the saved widget, running on this page (bottom corner). Conversations you have here show up in the log.
          </p>
        </div>
      </UCard>

      <ClientOnly>
        <helpinator-widget
          v-if="previewOn && saved"
          :key="previewKey"
          :host="hostOrigin"
          :widget-id="saved.id"
        />
      </ClientOnly>

      <UModal v-model:open="confirmDelete" title="Delete this widget?">
        <template #body>
          <p class="text-sm">
            The widget stops working on every site, and its whole conversation log is deleted. Conversations
            already sent to the inbox stay there.
          </p>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton variant="ghost" color="neutral" @click="confirmDelete = false">
              Cancel
            </UButton>
            <UButton color="error" @click="remove">
              Delete widget
            </UButton>
          </div>
        </template>
      </UModal>
    </div>
  </HelpinatorShell>
</template>
