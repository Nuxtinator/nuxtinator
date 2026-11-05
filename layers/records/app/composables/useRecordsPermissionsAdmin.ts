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

// In-flight dedupe for the catalog. SSR is off, so module state is safe.
let catalogPromise: Promise<void> | null = null

export function useRecordsPermissionsAdmin() {
  const catalog = useState<RecordsPermissionInfo[] | null>('records:perm-catalog', () => null)

  async function getRoleGrants(typeKey: string): Promise<RecordsRoleGrantsView> {
    return await $fetch<RecordsRoleGrantsView>(`/api/records/schema/types/${typeKey}/role-grants`)
  }

  /** Full replacement of the type's grants; answers with the fresh view. */
  async function saveRoleGrants(
    typeKey: string,
    grants: Record<string, Record<string, boolean>>
  ): Promise<RecordsRoleGrantsView> {
    return await $fetch<RecordsRoleGrantsView>(`/api/records/schema/types/${typeKey}/role-grants`, {
      method: 'PUT',
      body: { grants }
    })
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
    ensureCatalog,
    getUserGrants,
    addUserGrant,
    removeUserGrant
  }
}
