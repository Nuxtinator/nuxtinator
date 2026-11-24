import type { MaybeRefOrGetter } from 'vue'
import {
  arrangeApps,
  emptyAppLayout,
  isEmptyAppLayout,
  layoutWithAppMoved,
  layoutWithCategoryAdded,
  layoutWithCategoryMoved,
  layoutWithCategoryTitle,
  layoutWithoutCategory,
  parseAppLayout,
  type AppCategoryInfo,
  type AppLayout,
  type ArrangeableApp,
  type ArrangedCategory
} from '../utils/app-layout'

export type AppCategoryEdit = { mode: 'add' } | { mode: 'edit', category: ArrangedCategory<unknown> }

// Rearranging apps on an Apps settings page (an org's, or /admin/apps in single
// mode), rendered by <AppCategoryList>. Each change shows at once, saves the
// whole layout to `endpoint` (PUT; DELETE when nothing is left to store) and
// rolls back if the save fails.
export function useAppArrangement<T extends ArrangeableApp>(opts: {
  apps: MaybeRefOrGetter<T[]>
  categories: MaybeRefOrGetter<AppCategoryInfo[]>
  layout: MaybeRefOrGetter<AppLayout | undefined>
  endpoint: MaybeRefOrGetter<string>
  onSaved?: () => unknown
}) {
  const toast = useToast()
  const local = ref<AppLayout>(parseAppLayout(toValue(opts.layout)))
  watch(() => toValue(opts.layout), (v) => {
    local.value = parseAppLayout(v)
  })

  const groups = computed(() => arrangeApps(toValue(opts.apps), toValue(opts.categories), local.value, { includeEmpty: true }))
  const customized = computed(() => !isEmptyAppLayout(local.value))
  const saving = ref(false)
  const editing = ref<AppCategoryEdit | null>(null)

  async function commit(next: AppLayout) {
    const previous = local.value
    local.value = next
    saving.value = true
    try {
      await $fetch(toValue(opts.endpoint), isEmptyAppLayout(next) ? { method: 'DELETE' } : { method: 'PUT', body: next })
      await opts.onSaved?.()
    } catch (err) {
      local.value = previous
      toast.add({
        title: 'Couldn\'t save the order',
        description: (err as { data?: { statusMessage?: string } })?.data?.statusMessage,
        color: 'error'
      })
    } finally {
      saving.value = false
    }
  }

  function locate(appId: string) {
    const ci = groups.value.findIndex(c => c.apps.some(a => a.id === appId))
    return { ci, i: ci < 0 ? -1 : groups.value[ci]!.apps.findIndex(a => a.id === appId) }
  }

  function moveApp(appId: string, to: string, index: number) {
    const { ci, i } = locate(appId)
    if (ci >= 0 && groups.value[ci]!.id === to && i === index) return
    return commit(layoutWithAppMoved(local.value, groups.value, appId, to, index))
  }

  // One step up or down; past either end of its category it moves to the end
  // of the one above or the start of the one below.
  function moveAppBy(appId: string, delta: -1 | 1) {
    const { ci, i } = locate(appId)
    if (ci < 0) return
    const category = groups.value[ci]!
    const to = i + delta
    if (to >= 0 && to < category.apps.length) return moveApp(appId, category.id, to)
    const next = groups.value[ci + delta]
    if (!next) return
    return moveApp(appId, next.id, delta < 0 ? next.apps.length : 0)
  }

  function moveCategory(id: string, index: number) {
    if (groups.value.findIndex(c => c.id === id) === index) return
    return commit(layoutWithCategoryMoved(local.value, groups.value, id, index))
  }

  function moveCategoryBy(id: string, delta: -1 | 1) {
    const index = groups.value.findIndex(c => c.id === id) + delta
    if (index < 0 || index >= groups.value.length) return
    return moveCategory(id, index)
  }

  function addCategory(title: string) {
    return commit(layoutWithCategoryAdded(local.value, `c-${Math.random().toString(36).slice(2, 10)}`, title))
  }

  function renameCategory(category: ArrangedCategory<unknown>, title: string) {
    return commit(layoutWithCategoryTitle(local.value, category, title))
  }

  function removeCategory(id: string) {
    return commit(layoutWithoutCategory(local.value, id))
  }

  function reset() {
    return commit(emptyAppLayout())
  }

  return {
    groups,
    customized,
    saving,
    editing,
    openAdd: () => { editing.value = { mode: 'add' } },
    moveApp,
    moveAppBy,
    moveCategory,
    moveCategoryBy,
    addCategory,
    renameCategory,
    removeCategory,
    reset
  }
}

export type AppArrangement<T extends ArrangeableApp> = ReturnType<typeof useAppArrangement<T>>
