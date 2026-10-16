// Path of the signed-in app launcher: `/@<slug>/dashboard` inside an org, else
// `/dashboard` (which the tenancy route guard forwards into the active org).
export function launcherPath(orgSlug?: string | null): string {
  return orgSlug ? `/@${orgSlug}/dashboard` : '/dashboard'
}
