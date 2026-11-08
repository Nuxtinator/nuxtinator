<script setup lang="ts">
// The view's own fields: everyone who opens the view sees their values, its
// editors fill them in on each card, and only its owner adds, renames or
// deletes them. A field's kind is set when it's added. Select fields carry
// their choices; people fields can hold one person or several. Deleting a
// field deletes every value on it, after a confirm.
import type { ViewsFieldDef, ViewsFieldKind } from '../../utils/views-types'

const props = defineProps<{
  viewId: string
  fields: ViewsFieldDef[]
  /** Not the owner: the list only. */
  readonly: boolean
}>()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{
  changed: []
}>()

const toast = useToast()
const confirmAction = useConfirm()

const KIND_ITEMS: Array<{ value: ViewsFieldKind, label: string, icon: string }> = [
  { value: 'text', label: 'Text', icon: 'i-lucide-type' },
  { value: 'textarea', label: 'Long text', icon: 'i-lucide-align-left' },
  { value: 'number', label: 'Number', icon: 'i-lucide-hash' },
  { value: 'boolean', label: 'Yes / no', icon: 'i-lucide-square-check' },
  { value: 'date', label: 'Date', icon: 'i-lucide-calendar' },
  { value: 'key_select', label: 'Dropdown', icon: 'i-lucide-circle-chevron-down' },
  { value: 'multi_select', label: 'Multi select', icon: 'i-lucide-list-checks' },
  { value: 'tags', label: 'Tags', icon: 'i-lucide-tags' },
  { value: 'link', label: 'Links', icon: 'i-lucide-link' },
  { value: 'user_select', label: 'People', icon: 'i-lucide-users' },
  { value: 'attachments', label: 'Files', icon: 'i-lucide-paperclip' }
]
const kindMeta = (kind: ViewsFieldKind) => KIND_ITEMS.find(k => k.value === kind) ?? KIND_ITEMS[0]!
const hasOptions = (kind: ViewsFieldKind) => kind === 'key_select' || kind === 'multi_select'

// --- the form (add or edit one field) ---------------------------------------

const editing = ref<ViewsFieldDef | null>(null)
const formOpen = ref(false)
const label = ref('')
const kind = ref<ViewsFieldKind>('text')
const multiple = ref(false)
const options = ref<Array<{ key: string | null, label: string }>>([])
const saving = ref(false)

watch(open, (v) => {
  if (!v) formOpen.value = false
})

function startAdd() {
  editing.value = null
  label.value = ''
  kind.value = 'text'
  multiple.value = false
  options.value = [{ key: null, label: '' }]
  formOpen.value = true
}

function startEdit(field: ViewsFieldDef) {
  editing.value = field
  label.value = field.label
  kind.value = field.kind
  multiple.value = field.multiple === true
  options.value = Object.entries(field.options ?? {}).map(([key, o]) => ({ key, label: o.label }))
  formOpen.value = true
}

function optionKey(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'option'
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`
  taken.add(key)
  return key
}

// Existing choices keep their keys (stored values point at them); new ones
// get a key from their label.
function optionsPayload(): Record<string, { label: string }> {
  const kept = options.value.filter(o => o.label.trim() !== '')
  const taken = new Set(kept.map(o => o.key).filter((k): k is string => !!k))
  const out: Record<string, { label: string }> = {}
  for (const o of kept) out[o.key ?? optionKey(o.label, taken)] = { label: o.label.trim() }
  return out
}

const canSave = computed(() =>
  label.value.trim() !== ''
  && (!hasOptions(kind.value) || options.value.some(o => o.label.trim() !== '')))

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    const body: Record<string, unknown> = { label: label.value.trim() }
    if (hasOptions(kind.value)) body.options = optionsPayload()
    if (kind.value === 'user_select') body.multiple = multiple.value
    if (editing.value) {
      await $fetch(`/api/views/${props.viewId}/fields/${editing.value.key}`, { method: 'PATCH', body })
    } else {
      await $fetch(`/api/views/${props.viewId}/fields`, { method: 'POST', body: { ...body, kind: kind.value } })
    }
    formOpen.value = false
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to save the field') })
  } finally {
    saving.value = false
  }
}

async function remove(field: ViewsFieldDef) {
  const ok = await confirmAction({
    title: `Delete "${field.label}"?`,
    description: 'Every value filled in on this field is deleted with it.',
    confirmLabel: 'Delete field'
  })
  if (!ok) return
  try {
    await $fetch(`/api/views/${props.viewId}/fields/${field.key}`, { method: 'DELETE' })
    emit('changed')
  } catch (err) {
    toast.add({ color: 'error', title: recordsErrorMessage(err, 'Failed to delete the field') })
  }
}

function fieldMenu(field: ViewsFieldDef) {
  return [[
    { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => startEdit(field) },
    { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => remove(field) }
  ]]
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="formOpen ? (editing ? `Edit ${editing.label}` : 'Add a field') : 'Fields of this view'"
    :dismissible="!saving"
  >
    <template #body>
      <form
        v-if="formOpen"
        id="views-field-form"
        class="space-y-5"
        @submit.prevent="save"
      >
        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="label"
            autofocus
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="!editing"
          label="Kind"
        >
          <USelect
            v-model="kind"
            :items="KIND_ITEMS"
            value-key="value"
            label-key="label"
            :icon="kindMeta(kind).icon"
            class="w-full"
          />
        </UFormField>
        <UFormField
          v-if="hasOptions(kind)"
          label="Choices"
          required
        >
          <div class="space-y-2">
            <div
              v-for="(option, index) in options"
              :key="index"
              class="flex gap-2"
            >
              <UInput
                v-model="option.label"
                class="flex-1"
                :placeholder="`Choice ${index + 1}`"
              />
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                :aria-label="`Remove choice ${index + 1}`"
                @click="options.splice(index, 1)"
              />
            </div>
            <UButton
              icon="i-lucide-plus"
              variant="soft"
              size="sm"
              @click="options.push({ key: null, label: '' })"
            >
              Add choice
            </UButton>
          </div>
        </UFormField>
        <USwitch
          v-if="kind === 'user_select'"
          v-model="multiple"
          label="Several people"
        />
      </form>

      <div
        v-else
        class="space-y-3"
      >
        <ul
          v-if="fields.length > 0"
          class="divide-y divide-(--ui-border) rounded-md border border-(--ui-border)"
        >
          <li
            v-for="field in fields"
            :key="field.key"
            class="flex items-center gap-3 px-3 py-2"
          >
            <UIcon
              :name="kindMeta(field.kind).icon"
              class="size-4 shrink-0 text-(--ui-text-muted)"
            />
            <span class="flex-1 min-w-0 truncate text-sm">{{ field.label }}</span>
            <span class="text-xs text-(--ui-text-dimmed)">{{ kindMeta(field.kind).label }}</span>
            <UDropdownMenu
              v-if="!readonly"
              :items="fieldMenu(field)"
            >
              <UButton
                icon="i-lucide-ellipsis"
                variant="ghost"
                color="neutral"
                size="xs"
                :aria-label="`${field.label} options`"
              />
            </UDropdownMenu>
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-(--ui-text-muted)"
        >
          No fields yet.
        </p>
        <UButton
          v-if="!readonly"
          icon="i-lucide-plus"
          @click="startAdd"
        >
          Add field
        </UButton>
      </div>
    </template>

    <template #footer>
      <div class="flex gap-2 justify-end w-full">
        <template v-if="formOpen">
          <UButton
            variant="ghost"
            color="neutral"
            :disabled="saving"
            @click="formOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            type="submit"
            form="views-field-form"
            :loading="saving"
            :disabled="!canSave"
          >
            {{ editing ? 'Save' : 'Add field' }}
          </UButton>
        </template>
        <UButton
          v-else
          variant="ghost"
          color="neutral"
          @click="open = false"
        >
          Close
        </UButton>
      </div>
    </template>
  </UModal>
</template>
