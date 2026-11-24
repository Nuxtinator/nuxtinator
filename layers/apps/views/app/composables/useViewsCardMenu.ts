// A card's actions (copy link, duplicate, delete or remove), shown on
// right-click on board cards and list rows and in a list row's ⋯ menu. The
// view panel builds them, since it holds the permissions and the writes.
import type { InjectionKey } from 'vue'
import type { ViewsBoardItem } from '../utils/views-types'

export interface ViewsCardMenuItem {
  label: string
  icon: string
  color?: 'error'
  onSelect: () => void
}

/** The card's actions in groups; empty when it has none. */
export type ViewsCardMenu = (item: ViewsBoardItem) => ViewsCardMenuItem[][]

export const VIEWS_CARD_MENU_KEY: InjectionKey<ViewsCardMenu> = Symbol('views-card-menu')

export function useViewsCardMenu(): ViewsCardMenu {
  return inject(VIEWS_CARD_MENU_KEY, () => [])
}
