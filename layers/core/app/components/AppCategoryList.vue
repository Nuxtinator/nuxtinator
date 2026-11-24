<script setup lang="ts" generic="T extends ArrangeableApp">
import type { DropdownMenuItem } from '@nuxt/ui'
import { MORE_CATEGORY, type ArrangeableApp, type ArrangedApp, type ArrangedCategory } from '../utils/app-layout'
import type { AppArrangement } from '../composables/useAppArrangement'

// An Apps settings page's apps under their category cards. Apps and categories
// move by dragging their handle, by the arrow keys on a focused handle, or from
// the row's menu. The page renders each row's content in the `row` slot.
const props = defineProps<{ arrangement: AppArrangement<T> }>()
defineSlots<{ row(props: { app: ArrangedApp<T> }): unknown }>()

const { groups, saving, editing } = props.arrangement
const confirmAction = useConfirm()

// More shows only while it holds apps.
const visible = computed(() => groups.value.filter(c => c.apps.length > 0 || c.id !== MORE_CATEGORY))
const indexOf = (id: string) => groups.value.findIndex(c => c.id === id)

const drag = ref<{ kind: 'app' | 'category', id: string } | null>(null)
const over = ref<string | null>(null)

function onDragStart(event: DragEvent, kind: 'app' | 'category', id: string) {
  drag.value = { kind, id }
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', id)
  const source = (event.target as HTMLElement).closest(kind === 'app' ? 'li' : '[data-category]')
  if (source) event.dataTransfer.setDragImage(source, 16, 16)
}

function onDragEnd() {
  drag.value = null
  over.value = null
}

function onRowDragOver(event: DragEvent, appId: string) {
  if (drag.value?.kind !== 'app') return
  event.preventDefault()
  event.stopPropagation()
  over.value = `app:${appId}`
}

function onRowDrop(event: DragEvent, category: string, index: number) {
  if (drag.value?.kind !== 'app') return
  event.preventDefault()
  event.stopPropagation()
  const id = drag.value.id
  onDragEnd()
  props.arrangement.moveApp(id, category, index)
}

function onCategoryDragOver(event: DragEvent, id: string) {
  if (!drag.value) return
  event.preventDefault()
  over.value = `category:${id}`
}

// An app dropped on a category's card goes to its end; a category dropped on
// another takes its place.
function onCategoryDrop(event: DragEvent, category: ArrangedCategory<T>) {
  const dragged = drag.value
  if (!dragged) return
  event.preventDefault()
  onDragEnd()
  if (dragged.kind === 'app') props.arrangement.moveApp(dragged.id, category.id, category.apps.filter(a => a.id !== dragged.id).length)
  else props.arrangement.moveCategory(dragged.id, indexOf(category.id))
}

async function onHandleKey(event: KeyboardEvent, kind: 'app' | 'category', id: string) {
  const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
  if (!delta) return
  event.preventDefault()
  if (kind === 'app') props.arrangement.moveAppBy(id, delta)
  else props.arrangement.moveCategoryBy(id, delta)
  await nextTick()
  document.querySelector<HTMLElement>(`[data-${kind}-handle="${id}"]`)?.focus()
}

function appMenu(app: ArrangedApp<T>, category: ArrangedCategory<T>, i: number): DropdownMenuItem[][] {
  const ci = indexOf(category.id)
  const others = visible.value.filter(c => c.id !== category.id)
  return [
    [
      { label: 'Move up', icon: 'i-lucide-arrow-up', disabled: ci === 0 && i === 0, onSelect: () => props.arrangement.moveAppBy(app.id, -1) },
      { label: 'Move down', icon: 'i-lucide-arrow-down', disabled: ci === groups.value.length - 1 && i === category.apps.length - 1, onSelect: () => props.arrangement.moveAppBy(app.id, 1) }
    ],
    ...(others.length > 0
      ? [[{
          label: 'Move to',
          icon: 'i-lucide-folder-input',
          children: others.map(c => ({ label: c.title, onSelect: () => props.arrangement.moveApp(app.id, c.id, c.apps.length) }))
        }]]
      : [])
  ]
}

const editOpen = computed({
  get: () => editing.value !== null,
  set: (v: boolean) => { if (!v) editing.value = null }
})
function openEdit(category: ArrangedCategory<T>) {
  editing.value = { mode: 'edit', category }
}
function closeEdit() {
  editing.value = null
}
const editCategory = computed(() => editing.value?.mode === 'edit' ? editing.value.category : null)
const name = ref('')
watch(editing, (e) => {
  name.value = e?.mode === 'edit' && (e.category.custom || e.category.title !== e.category.defaultTitle) ? e.category.title : ''
})
// A built-in category saved with no name goes back to its own.
const canSave = computed(() => name.value.trim().length > 0 || (editCategory.value !== null && !editCategory.value.custom))

function onSubmit() {
  if (!canSave.value) return
  const e = editing.value
  editing.value = null
  if (e?.mode === 'add') props.arrangement.addCategory(name.value)
  else if (e?.mode === 'edit') props.arrangement.renameCategory(e.category, name.value)
}

async function onDelete() {
  const category = editCategory.value
  if (!category) return
  editing.value = null
  if (!await confirmAction({ title: `Delete ${category.title}?`, description: 'Its apps go back to their own categories.', confirmLabel: 'Delete' })) return
  props.arrangement.removeCategory(category.id)
}

const handleClass = 'shrink-0 p-1 rounded text-(--ui-text-dimmed) hover:text-(--ui-text) cursor-grab focus-visible:outline-2 focus-visible:outline-(--ui-primary) disabled:cursor-default disabled:opacity-50'
</script>

<template>
  <div class="space-y-4">
    <div
      v-for="category in visible"
      :key="category.id"
      :data-category="category.id"
      class="rounded-lg transition-opacity"
      :class="{
        'opacity-40': drag?.kind === 'category' && drag.id === category.id,
        'outline-2 outline-(--ui-primary)': over === `category:${category.id}` && drag?.id !== category.id
      }"
      @dragover="onCategoryDragOver($event, category.id)"
      @drop="onCategoryDrop($event, category)"
    >
      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header>
          <div class="flex items-center gap-2">
            <button
              type="button"
              draggable="true"
              :data-category-handle="category.id"
              :class="handleClass"
              :disabled="saving"
              :aria-label="`Move ${category.title}`"
              @dragstart="onDragStart($event, 'category', category.id)"
              @dragend="onDragEnd"
              @keydown="onHandleKey($event, 'category', category.id)"
            >
              <UIcon
                name="i-lucide-grip-vertical"
                class="size-4 block"
              />
            </button>
            <h2 class="font-semibold truncate">
              {{ category.title }}
            </h2>
            <UButton
              variant="ghost"
              color="neutral"
              size="xs"
              icon="i-lucide-pencil"
              :disabled="saving"
              :aria-label="`Edit ${category.title}`"
              @click="openEdit(category)"
            />
          </div>
        </template>

        <ul class="divide-y divide-(--ui-border)">
          <li
            v-for="(app, i) in category.apps"
            :key="app.id"
            class="flex items-center gap-2 py-3 ps-2 pe-3 transition-colors"
            :class="{
              'opacity-40': drag?.kind === 'app' && drag.id === app.id,
              'bg-(--ui-bg-elevated)': over === `app:${app.id}` && drag?.id !== app.id
            }"
            @dragover="onRowDragOver($event, app.id)"
            @drop="onRowDrop($event, category.id, i)"
          >
            <button
              type="button"
              draggable="true"
              :data-app-handle="app.id"
              :class="handleClass"
              :disabled="saving"
              :aria-label="`Move ${app.title}`"
              @dragstart="onDragStart($event, 'app', app.id)"
              @dragend="onDragEnd"
              @keydown="onHandleKey($event, 'app', app.id)"
            >
              <UIcon
                name="i-lucide-grip-vertical"
                class="size-4 block"
              />
            </button>
            <div class="min-w-0 flex-1">
              <slot
                name="row"
                :app="app"
              />
            </div>
            <UDropdownMenu :items="appMenu(app, category, i)">
              <UButton
                variant="ghost"
                color="neutral"
                size="sm"
                icon="i-lucide-ellipsis"
                :disabled="saving"
                :aria-label="`More for ${app.title}`"
              />
            </UDropdownMenu>
          </li>
          <li
            v-if="category.apps.length === 0"
            class="p-4 text-sm text-(--ui-text-muted)"
          >
            No apps
          </li>
        </ul>
      </UCard>
    </div>

    <UModal
      v-model:open="editOpen"
      :title="editing?.mode === 'add' ? 'Add category' : 'Edit category'"
    >
      <template #body>
        <UForm
          id="app-category-form"
          :state="{ name }"
          class="space-y-5"
          @submit="onSubmit"
        >
          <UFormField
            label="Name"
            name="name"
          >
            <UInput
              v-model="name"
              :placeholder="editCategory?.defaultTitle ?? ''"
              :maxlength="60"
              autofocus
              class="w-full"
            />
          </UFormField>
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full items-center gap-2">
          <UButton
            v-if="editCategory?.custom"
            color="error"
            variant="outline"
            @click="onDelete"
          >
            Delete category
          </UButton>
          <div class="ms-auto flex gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="closeEdit"
            >
              Cancel
            </UButton>
            <UButton
              type="submit"
              form="app-category-form"
              :disabled="!canSave"
            >
              {{ editing?.mode === 'add' ? 'Add category' : 'Save' }}
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
