// Links to the board of what sits under a record (a task's subtasks). The
// link carries the view the person started from as ?from=, and the records
// whose boards they went through on the way as ?path=, so every board below
// leads its trail with exactly the steps taken. ViewPanel provides both.
import type { InjectionKey, Ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { viewsSubtasksViewId } from '../utils/views-types'

/** The id of the view a drill-down started from, for boards opened below it. */
export const VIEWS_ORIGIN_KEY: InjectionKey<Ref<string | null>> = Symbol('views-origin')

/** The records whose boards a drill-down went through, top first, for boards opened below. */
export const VIEWS_PATH_KEY: InjectionKey<Ref<string[]>> = Symbol('views-path')

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** The record ids in a ?path= value. */
export function viewsParsePath(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  return value.split(',').filter(id => UUID_RE.test(id)).slice(0, 50)
}

/** `ownOrigin` / `ownPath` are for the component that provides them, which can't inject them. */
export function useViewsSubtasksBoard(ownOrigin?: Ref<string | null>, ownPath?: Ref<string[]>) {
  const viewsPath = useViewsPath()
  const origin = ownOrigin ?? inject(VIEWS_ORIGIN_KEY, null)
  const path = ownPath ?? inject(VIEWS_PATH_KEY, null)

  /** The route of view `viewId`, keeping the trail's starting view and the records `through` on the way. */
  function viewRoute(viewId: string, through: string[] = []): RouteLocationRaw {
    const from = origin?.value
    if (!from || from === viewId) return { path: viewsPath(`/${viewId}`), query: {} }
    return { path: viewsPath(`/${viewId}`), query: through.length > 0 ? { from, path: through.join(',') } : { from } }
  }

  const boardRoute = (recordId: string) => viewRoute(viewsSubtasksViewId(recordId), path?.value ?? [])

  return { viewRoute, boardRoute, openBoard: (recordId: string) => navigateTo(boardRoute(recordId)) }
}
