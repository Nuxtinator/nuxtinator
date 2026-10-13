// Sign-in provider registry. A layer that adds a way to sign in (e.g. Google
// or Apple) registers it from a Nitro plugin; core's login, register,
// accept-invite and account pages render a button per provider via
// `/api/_auth-providers`, and `/api/auth/methods` uses the callbacks to list
// and unlink a user's identities.
//
// `startPath` is a browser-navigable URL that begins the provider's web flow.
// Core appends `intent` (login | link | reauth), and optionally `invite` and
// `redirect`, as query parameters.

export interface LinkedIdentity {
  email: string | null
}

export interface AuthProvider {
  id: string
  label: string
  icon: string
  startPath: string
  order?: number
  getLinkedIdentity: (userId: string) => Promise<LinkedIdentity | null>
  unlink: (userId: string) => Promise<void>
}

const _providers: AuthProvider[] = []

export function registerAuthProvider(provider: AuthProvider): void {
  if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) return
  if (_providers.some(p => p.id === provider.id)) return
  _providers.push(provider)
}

export function getAuthProviders(): AuthProvider[] {
  return [..._providers].sort((a, b) => {
    const ao = a.order ?? 100
    const bo = b.order ?? 100
    if (ao !== bo) return ao - bo
    return a.id.localeCompare(b.id)
  })
}

export function getAuthProvider(id: string): AuthProvider | undefined {
  return _providers.find(p => p.id === id)
}

// Every way the user can currently sign in: a password, plus each linked
// provider identity.
export async function listSignInMethods(userId: string, hasPassword: boolean) {
  const providers = await Promise.all(getAuthProviders().map(async p => ({
    id: p.id,
    label: p.label,
    icon: p.icon,
    startPath: p.startPath,
    linked: await p.getLinkedIdentity(userId)
  })))
  return {
    password: hasPassword,
    providers,
    count: (hasPassword ? 1 : 0) + providers.filter(p => p.linked).length
  }
}
