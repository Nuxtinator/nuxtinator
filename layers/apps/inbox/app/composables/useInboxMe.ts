// The caller's own sending identity + the From options the composer offers.
// Org-keyed (an org switch changes the alias/signature and the contact
// address). `saveIdentity` PUTs the caller's own row; the alias field is only
// accepted server-side from settings managers, mirrored here by `canManageSettings`.

export interface InboxMe {
  userId: string
  alias: string | null
  signature: string | null
  personalFrom: string | null
  contactAddress: string | null
  // The org's display name on shared-address sends ("Acme Support").
  brandFromName: string | null
  // inbox.settings.manage: the settings page and teammates' aliases.
  canManageSettings: boolean
  // Org admin: moderates notes and clears suppressions.
  canModerate: boolean
}

export function useInboxMe() {
  const orgKey = useCrmOrgKey()
  const me = ref<InboxMe | null>(null)

  async function refresh(): Promise<void> {
    try {
      me.value = await $fetch<InboxMe>('/api/inbox/me')
    } catch {
      me.value = null
    }
  }

  async function saveIdentity(patch: { alias?: string | null, signature?: string | null }): Promise<void> {
    if (!me.value) return
    const url: string = `/api/inbox/identities/${me.value.userId}`
    await $fetch(url, { method: 'PUT', body: patch })
    await refresh()
  }

  watch(orgKey, () => refresh(), { immediate: true })

  return { me, refresh, saveIdentity }
}
