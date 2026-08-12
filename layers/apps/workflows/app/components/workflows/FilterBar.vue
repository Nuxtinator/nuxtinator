<script setup lang="ts">
// The view's filter surface, two tiers reusing CRM's filter chips:
//
// - Personal (everyone): search + chips held in session state only — they
//   overlay the saved filters per key for this caller and vanish on reload.
// - Saved (edit access): the view definition's shared filters, editable in
//   a collapsible section; every change persists for every viewer.
//
// Status rides inside each filters object as a bare equality on the
// intrinsic `status` key; the computed adapters below split it out for
// CrmRecordFilters' separate status model.
import type { CrmFieldSetting } from '../../../../crm/app/utils/field-kinds'
import type { WorkflowsViewDetail } from '../../utils/workflows-types'

const props = defineProps<{
  view: WorkflowsViewDetail
  fields: CrmFieldSetting[]
  canEditDefinition: boolean
}>()

const q = defineModel<string>('q', { default: '' })
const personalFilters = defineModel<Record<string, unknown>>('personalFilters', { default: () => ({}) })

const emit = defineEmits<{
  definitionFilters: [filters: Record<string, unknown>]
}>()

const statusField = computed(() =>
  props.fields.find(f => f.column === 'status') ?? null)

function splitStatus(
  read: () => Record<string, unknown>,
  write: (next: Record<string, unknown>) => void
) {
  const status = computed<string | null>({
    get: () => {
      const v = read().status
      return typeof v === 'string' ? v : null
    },
    set: (v) => {
      const next = { ...read() }
      if (v) next.status = v
      else delete next.status
      write(next)
    }
  })
  const rest = computed<Record<string, unknown>>({
    get: () => {
      const { status: _, ...others } = read()
      return others
    },
    set: (v) => {
      const current = read()
      const next: Record<string, unknown> = { ...v }
      if (typeof current.status === 'string') next.status = current.status
      write(next)
    }
  })
  return { status, rest }
}

const personal = splitStatus(
  () => personalFilters.value,
  next => personalFilters.value = next
)

// Saved filters edit a local draft so chip interactions feel instant; each
// change persists (the page PATCHes the definition).
const sharedDraft = ref<Record<string, unknown>>({ ...(props.view.definition.filters ?? {}) })
watch(() => props.view.definition.filters, (v) => {
  sharedDraft.value = { ...(v ?? {}) }
})
const shared = splitStatus(
  () => sharedDraft.value,
  (next) => {
    sharedDraft.value = next
    emit('definitionFilters', next)
  }
)

const sharedCount = computed(() => Object.keys(props.view.definition.filters ?? {}).length)
const personalCount = computed(() => Object.keys(personalFilters.value).length)

const savedOpen = ref(false)
</script>

<template>
  <div class="border-b border-(--ui-border) bg-(--ui-bg) px-4 py-2 space-y-2">
    <div class="flex items-center gap-2 flex-wrap">
      <div class="flex-1 min-w-64">
        <CrmRecordFilters
          v-model:q="q"
          v-model:status="personal.status.value"
          v-model:filters="personal.rest.value"
          :status-field="statusField"
          :fields="fields"
        />
      </div>
      <UBadge
        v-if="personalCount > 0"
        variant="subtle"
        color="info"
        icon="i-lucide-user"
      >
        Personal
      </UBadge>
      <UButton
        v-if="canEditDefinition"
        :icon="savedOpen ? 'i-lucide-chevron-up' : 'i-lucide-bookmark'"
        variant="ghost"
        color="neutral"
        size="sm"
        @click="savedOpen = !savedOpen"
      >
        Saved filters{{ sharedCount > 0 ? ` (${sharedCount})` : '' }}
      </UButton>
      <UBadge
        v-else-if="sharedCount > 0"
        variant="subtle"
        color="neutral"
        icon="i-lucide-bookmark"
      >
        {{ sharedCount }} saved filter{{ sharedCount === 1 ? '' : 's' }}
      </UBadge>
    </div>

    <div
      v-if="savedOpen && canEditDefinition"
      class="rounded-lg border border-dashed border-(--ui-border) p-2"
    >
      <p class="text-xs text-(--ui-text-muted) mb-2">
        Saved filters apply for everyone who opens this view.
      </p>
      <!-- Text search is session state, not part of the saved definition —
           the wrapper hides CrmRecordFilters' search input (its first row's
           first element) since the component has no prop for that. -->
      <div class="[&>div>div:first-child>*:first-child]:hidden">
        <CrmRecordFilters
          v-model:status="shared.status.value"
          v-model:filters="shared.rest.value"
          :status-field="statusField"
          :fields="fields"
        />
      </div>
    </div>
  </div>
</template>
