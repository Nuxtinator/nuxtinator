// Gates `/@<slug>/settings*` to users who hold the `org.settings.access`
// permission. The default `member` role doesn't get it; admins do via the
// `admin` role special-case in core's rbac.ts (which grants every registered
// permission). Custom roles can be given `org.settings.access` to let them
// enter the settings shell — individual tabs still enforce their own perms
// (org.members.*, org.roles.*, org.settings.write, org.apps.manage).
//
// Server endpoints are individually permission-gated already; this guard is
// purely a UX layer that prevents members from landing on broken pages.
const SETTINGS_RE = /^\/@([^/]+)\/settings(?:\/.*)?$/

export default defineNuxtRouteMiddleware(async (to) => {
  const match = to.path.match(SETTINGS_RE)
  if (!match) return
  const slug = match[1]!

  const cache = useState<Record<string, string[]>>('tenant:settings-perms', () => ({}))
  let perms = cache.value[slug]
  if (!perms) {
    try {
      const res = await $fetch<{ perms: string[] }>(`/api/o/${slug}`)
      perms = res.perms ?? []
      cache.value = { ...cache.value, [slug]: perms }
    } catch {
      return navigateTo(launcherPath(slug))
    }
  }

  if (!perms.includes('org.settings.access')) {
    return navigateTo(launcherPath(slug))
  }
})
