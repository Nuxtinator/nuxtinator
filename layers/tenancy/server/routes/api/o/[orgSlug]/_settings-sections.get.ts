import { withOrgContext } from '#tenant/server'
import { getOrgSettingsSections } from '#core/server/utils/org-settings-section-registry'

// Layer-registered org settings sections for the active org, filtered to the
// caller's permissions and resolved to concrete links. The settings shell
// renders these after its built-in tabs.
export default defineEventHandler(async (event) => {
  return await withOrgContext(event, async (_tx, ctx) => {
    const sections = getOrgSettingsSections()
      .filter((section) => {
        if (!section.requiredPermission) return true
        return ctx.perms.has(section.requiredPermission as never)
      })
      .map(section => ({
        appId: section.appId,
        title: section.title,
        icon: section.icon ?? 'i-lucide-circle',
        to: `/@${ctx.orgSlug}/settings/${section.path}`
      }))
    return { sections }
  })
})
