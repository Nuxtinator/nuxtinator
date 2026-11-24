// How the embeddable widget presents itself for a project. A project stores
// `post_meta.widget_mode` only when it was switched to testing; anything else
// reads as the standard corner button.
export type WidgetMode = 'standard' | 'testing'

export function widgetModeOf(postMeta: Record<string, unknown> | null | undefined): WidgetMode {
  return postMeta?.widget_mode === 'testing' ? 'testing' : 'standard'
}
