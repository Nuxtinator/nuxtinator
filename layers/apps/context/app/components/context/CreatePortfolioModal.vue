<script setup lang="ts">
interface TemplateOption {
  id: string
  label: string
  description: string | null
  sections: Array<{ key: string, title: string, description: string }>
}

const open = defineModel<boolean>('open', { default: false })

const route = useRoute()
const step = ref<1 | 2>(1)
const form = reactive({ name: '', color: '#7c3aed' })
const selected = ref(new Set<string>())
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

const templates = ref<TemplateOption[] | null>(null)
const templateId = ref<string>('')
const template = computed(() => templates.value?.find(t => t.id === templateId.value) ?? null)
const templateItems = computed(() => (templates.value ?? []).map(t => ({ label: t.label, value: t.id })))
const stepTwoDescription = computed(() => templateItems.value.length > 1
  ? 'Choose a template and which of its sections the portfolio starts with.'
  : 'Choose which built-in sections the portfolio starts with.')

watch(templateId, () => {
  selected.value = new Set(template.value?.sections.map(s => s.key) ?? [])
})

watch(open, async (v) => {
  if (v) {
    step.value = 1
    form.name = ''
    form.color = '#7c3aed'
    errorMsg.value = null
    try {
      templates.value ??= (await $fetch<{ templates: TemplateOption[] }, string>('/api/context/templates')).templates
      templateId.value = templates.value[0]?.id ?? ''
      selected.value = new Set(template.value?.sections.map(s => s.key) ?? [])
    } catch {
      errorMsg.value = 'Could not load portfolio templates.'
    }
  }
})

function next() {
  if (form.name.trim()) step.value = 2
}

function toggle(key: string, next: boolean) {
  const s = new Set(selected.value)
  if (next) s.add(key)
  else s.delete(key)
  selected.value = s
}

function pathTo(p: string): string {
  const org = route.params.orgSlug as string | undefined
  return org ? `/@${org}${p}` : p
}

async function create() {
  submitting.value = true
  errorMsg.value = null
  try {
    const created = await $fetch<{ slug: string }, string>('/api/context/portfolios', {
      method: 'POST',
      body: {
        name: form.name.trim(),
        color: form.color || null,
        template: templateId.value,
        builtin_sections: (template.value?.sections ?? []).map(s => s.key).filter(k => selected.value.has(k))
      }
    })
    open.value = false
    await refreshNuxtData('context-sidebar-portfolios')
    await navigateTo(pathTo(`/context/${created.slug}`))
  } catch (e) {
    errorMsg.value = (e as { statusMessage?: string }).statusMessage ?? 'Could not create portfolio.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="step === 1 ? 'New portfolio' : 'Built-in sections'"
    :description="step === 2 ? stepTwoDescription : undefined"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <ContextPortfolioForm
        v-if="step === 1"
        v-model="form"
        submit-label="Next"
        @submit="next"
      />
      <div v-else class="space-y-4">
        <UFormField v-if="templateItems.length > 1" label="Template" :description="template?.description ?? undefined">
          <USelect v-model="templateId" :items="templateItems" :disabled="submitting" class="w-full" />
        </UFormField>
        <ContextSectionChecklist v-if="template" :sections="template.sections" :selected="selected" :disabled="submitting" @toggle="toggle" />
        <p class="text-xs text-(--ui-text-muted)">
          You can add or remove sections later in portfolio settings.
        </p>
        <p v-if="errorMsg" class="text-xs text-(--ui-error)">
          {{ errorMsg }}
        </p>
        <div class="flex justify-between">
          <UButton variant="ghost" color="neutral" :disabled="submitting" @click="step = 1">
            Back
          </UButton>
          <UButton :loading="submitting" :disabled="!template" @click="create">
            Create
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
