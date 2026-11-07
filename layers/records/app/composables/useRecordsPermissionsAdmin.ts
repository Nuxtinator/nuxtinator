// Client wrappers for the roles & permissions admin surface: the per-type
// role matrix (role-grants routes), the crm.* permission catalog, and the
// per-user extra grants. The matrix and grants views are fetched fresh on
// use — they're tiny, admin-only reads and every write answers with the
// refreshed state, so nothing here needs an org-keyed cache. The permission
// catalog is code-registered and org-independent, so one copy per session
// is safe (the one deliberate exception to gotcha 11's org-keying rule).

/** One assignable role as served by the role-grants routes. */
export interface RecordsMatrixRole {
  key: string
  label: string
  /** True for org custom roles; false for host/app-static roles. */
  custom: boolean
}

/** One effective-answer cell of the matrix. */
export interface RecordsEffectiveCell {
  /** What the evaluator answers for a user holding only this role. */
  allowed: boolean
  /** 'row' = explicit grant, 'slug' = role-slug fallback, 'admin' = bypass. */
  source: 'row' | 'slug' | 'admin'
  /** The role's slug-only answer — what an Inherit cell resolves to. */
  fallback: boolean
}

/** Response of GET/PUT /api/records/schema/types/:type/role-grants. */
export interface RecordsRoleGrantsView {
  actions: string[]
  roles: RecordsMatrixRole[]
  /** The stored override rows — only explicit true/false entries exist. */
  grants: Record<string, Record<string, boolean>>
  effective: Record<string, Record<string, RecordsEffectiveCell>>
  /** The org's teams; archived ones only while they carry grants. */
  teams: Array<{ id: string, name: string, icon: string | null, image: string | null, archived: boolean }>
  /** Team id → the actions that team is given on top of roles. */
  teamGrants: Record<string, Record<string, true>>
}

/** A catalog entry as served by GET /api/records/schema/permissions. */
export interface RecordsPermissionInfo {
  key: string
  title: string
  description: string
}

/** A direct grant as served by the user-grants routes. */
export interface RecordsUserGrant {
  permission: string
  title: string
  /** True when the slug is no longer registered — inert but revocable. */
  orphan: boolean
  grantedBy: string | null
  createdAt: string
}

/** Who can see and update a type's records, as asked when creating a type. */
export type RecordsTypeAccess = 'everyone' | 'involved' | 'admins'

// 'everyone' grants the member role full use; other roles keep their slug
// answers. 'admins' denies every non-admin role. 'involved' stores nothing:
// members see only records they created, are assigned to, or had shared
// with them.
const ACCESS_PRESETS: Record<Exclude<RecordsTypeAccess, 'involved'>, { roles: 'member' | 'non-admin', grants: Record<string, boolean> }> = {
  everyone: { roles: 'member', grants: { read: true, create: true, update: true, view_all: true } },
  admins: { roles: 'non-admin', grants: { read: false, create: false, update: false, delete: false, share: false, view_all: false } }
}

// In-flight dedupe for the catalog. SSR is off, so module state is safe.
let catalogPromise: Promise<void> | null = null

export function useRecordsPermissionsAdmin() {
  const catalog = useState<RecordsPermissionInfo[] | null>('records:perm-catalog', () => null)

  async function getRoleGrants(typeKey: string): Promise<RecordsRoleGrantsView> {
    return await $fetch<RecordsRoleGrantsView>(`/api/records/schema/types/${typeKey}/role-grants`)
  }

  /** Full replacement of the type's grants; answers with the fresh view. Team grants are replaced only when given. */
  async function saveRoleGrants(
    typeKey: string,
    grants: Record<string, Record<string, boolean>>,
    teamGrants?: Record<string, Record<string, true>>
  ): Promise<RecordsRoleGrantsView> {
    return await $fetch<RecordsRoleGrantsView>(`/api/records/schema/types/${typeKey}/role-grants`, {
      method: 'PUT',
      body: teamGrants ? { grants, teamGrants } : { grants }
    })
  }

  /** Writes the access preset's role grants for the type. */
  async function applyTypeAccess(typeKey: string, access: RecordsTypeAccess): Promise<void> {
    if (access === 'involved') return
    const view = await getRoleGrants(typeKey)
    const preset = ACCESS_PRESETS[access]
    const roles = view.roles.filter(r => preset.roles === 'member' ? r.key === 'member' : r.key !== 'admin')
    const grants = Object.fromEntries(roles.map(r => [r.key, { ...preset.grants }]))
    await saveRoleGrants(typeKey, grants)
  }

  /** Fetches the crm.* permission catalog once; concurrent callers share it. */
  async function ensureCatalog(): Promise<RecordsPermissionInfo[]> {
    if (catalog.value) return catalog.value
    if (!catalogPromise) {
      catalogPromise = $fetch<{ permissions: RecordsPermissionInfo[] }>('/api/records/schema/permissions')
        .then((res) => {
          catalog.value = res.permissions
        })
        .finally(() => {
          catalogPromise = null
        })
    }
    await catalogPromise
    return catalog.value ?? []
  }

  async function getUserGrants(userId: string): Promise<RecordsUserGrant[]> {
    const res = await $fetch<{ items: RecordsUserGrant[] }>('/api/records/schema/user-grants', {
      query: { userId }
    })
    return res.items
  }

  async function addUserGrant(userId: string, permission: string): Promise<RecordsUserGrant[]> {
    const res = await $fetch<{ items: RecordsUserGrant[] }>('/api/records/schema/user-grants', {
      method: 'POST',
      body: { userId, permission }
    })
    return res.items
  }

  async function removeUserGrant(userId: string, permission: string): Promise<RecordsUserGrant[]> {
    const res = await $fetch<{ items: RecordsUserGrant[] }>(
      `/api/records/schema/user-grants/${userId}/${permission}`,
      { method: 'DELETE' }
    )
    return res.items
  }

  return {
    catalog,
    getRoleGrants,
    saveRoleGrants,
    applyTypeAccess,
    ensureCatalog,
    getUserGrants,
    addUserGrant,
    removeUserGrant
  }
}
