// Links to the board of what sits under a record (a task's subtasks). The
// link carries the view the person started from as ?from=, so every board
// below it can lead its trail with that view. ViewPanel provides it.
import type { InjectionKey, Ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { viewsSubtasksViewId } from '../utils/views-types'

/** The id of the view a drill-down started from, for boards opened below it. */
export const VIEWS_ORIGIN_KEY: InjectionKey<Ref<string | null>> = Symbol('views-origin')

/** `ownOrigin` is for the component that provides the origin, which can't inject it. */
export function useViewsSubtasksBoard(ownOrigin?: Ref<string | null>) {
  const viewsPath = useViewsPath()
  const origin = ownOrigin ?? inject(VIEWS_ORIGIN_KEY, null)

  /** The route of view `viewId`, keeping the trail's starting view. */
  function viewRoute(viewId: string): RouteLocationRaw {
    const from = origin?.value
    return { path: viewsPath(`/${viewId}`), query: from && from !== viewId ? { from } : {} }
  }

  const boardRoute = (recordId: string) => viewRoute(viewsSubtasksViewId(recordId))

  return { viewRoute, boardRoute, openBoard: (recordId: string) => navigateTo(boardRoute(recordId)) }
}
