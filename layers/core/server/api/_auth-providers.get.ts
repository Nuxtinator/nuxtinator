import { getAuthProviders } from '../utils/auth-provider-registry'

// Public: the sign-in providers whose buttons the auth pages should render.
export default defineEventHandler(() => {
  return getAuthProviders().map(p => ({ id: p.id, label: p.label, icon: p.icon, startPath: p.startPath }))
})
