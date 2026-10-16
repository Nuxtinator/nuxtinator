// Host-admin gate for `/admin/*` routes. Single-bit check against
// `users.is_admin` mirrored on the JWT user; server endpoints use
// `requireOperatorAdmin` for the authoritative check, so this is just a routing
// hint — bypassing it lands the user on a 403 from the API anyway.
export default defineNuxtRouteMiddleware(async (_to, _from) => {
  const { user, checkAuth } = useAuth()

  let currentUser = user.value
  if (!currentUser) {
    currentUser = await checkAuth()
  }

  if (!currentUser) {
    return navigateTo('/login')
  }

  if (!(currentUser as { is_admin?: boolean }).is_admin) {
    return navigateTo(launcherPath())
  }
})
