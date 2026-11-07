// The per-org tag palette (slug → name/colour) plus the mutations that manage
// it and assign tags to a conversation. The palette is small and read on every
// list render, so it's fetched once per org and cached in this composable's
// module scope; org switches reload it. Conversations store only slugs, so the
// palette is what resolves a slug to its display name and colour everywhere
// (rail folders, list chips, the picker).

// Mirror of the server InboxTag shape. Colours are Nuxt UI theme colours so a
// tag renders directly as <UBadge :color>.
export const INBOX_TAG_COLORS = ['neutral', 'primary', 'secondary', 'info', 'success', 'warning', 'error'] as const
export type InboxTagColor = typeof INBOX_TAG_COLORS[number]
export interface InboxTag { slug: string, name: string, color: InboxTagColor }

export function useInboxTags() {
  const orgKey = useRecordsOrgKey()
  const palette = ref<InboxTag[]>([])
  const pending = ref(false)

  async function refresh(): Promise<void> {
    pending.value = true
    try {
      const res = await $fetch<{ tags: InboxTag[] }>('/api/inbox/tags')
      palette.value = res.tags
    } catch {
      palette.value = []
    } finally {
      pending.value = false
    }
  }

  // Create-or-return by derived slug — the server never overwrites an existing
  // tag's colour, so an inline create-on-assign can't duplicate or mutate.
  // Reloads the palette so a brand-new tag appears in the rail and picker.
  async function createTag(name: string, color: InboxTagColor): Promise<InboxTag> {
    const res = await $fetch<{ tag: InboxTag }>('/api/inbox/tags', { method: 'POST', body: { name, color } })
    await refresh()
    return res.tag
  }

  async function deleteTag(slug: string): Promise<void> {
    const url: string = `/api/inbox/tags/${slug}`
    await $fetch(url, { method: 'DELETE' })
    await refresh()
  }

  // Whole-set replace of one conversation's tags. Returns the server-sanitized
  // set so the caller adopts exactly what was stored (unknown slugs dropped).
  async function setConversationTags(conversationId: string, slugs: string[]): Promise<string[]> {
    const url: string = `/api/inbox/conversations/${conversationId}/tags`
    const res = await $fetch<{ tags: string[] }>(url, { method: 'PUT', body: { tags: slugs } })
    return res.tags
  }

  const bySlug = computed(() => {
    const map = new Map<string, InboxTag>()
    for (const t of palette.value) map.set(t.slug, t)
    return map
  })
  // Resolve a stored slug to a renderable tag; unknown slugs (palette not yet
  // loaded, or a slug removed elsewhere) fall back to a neutral chip.
  function resolve(slug: string): InboxTag {
    return bySlug.value.get(slug) ?? { slug, name: slug, color: 'neutral' }
  }

  watch(orgKey, () => refresh(), { immediate: true })

  return { palette, pending, refresh, createTag, deleteTag, setConversationTags, resolve }
}
