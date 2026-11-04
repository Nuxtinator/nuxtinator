// Org settings navigation registry. The tenancy layer's per-org settings
// shell (`/@<slug>/settings`) renders its own built-in tabs (General, Members,
// Roles, Apps, Activity) and then every section registered here, so an
// optional layer can add an org-level settings page without the tenancy layer
// knowing it exists. Single-tenant deployments have no org settings shell, so
// registrations are inert there.
//
// One nav source, one renderer: `/api/o/<slug>/_settings-sections` →
// the tenancy settings page.

export interface OrgSettingsSection {
  appId: string
  title: string
  // Path segment under the org settings root: 'ai' renders at
  // `/@<slug>/settings/ai`. The owning layer ships the matching page at
  // `app/pages/@[orgSlug]/settings/<path>.vue`.
  path: string
  icon?: string
  requiredPermission?: string
  order?: number
}

const _sections: OrgSettingsSection[] = []

export function registerOrgSettingsSection(section: OrgSettingsSection): void {
  if (!section || typeof section.path !== 'string' || section.path.length === 0) return
  if (typeof section.appId !== 'string' || section.appId.length === 0) return
  _sections.push(section)
}

export function getOrgSettingsSections(): OrgSettingsSection[] {
  return [..._sections].sort((a, b) => {
    const ao = a.order ?? 100
    const bo = b.order ?? 100
    if (ao !== bo) return ao - bo
    return a.title.localeCompare(b.title)
  })
}

export function __resetOrgSettingsSectionRegistryForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetOrgSettingsSectionRegistryForTests is not callable in production')
  }
  _sections.length = 0
}
