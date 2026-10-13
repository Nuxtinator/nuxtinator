const CACHE_KEY = 'auth.user.cache'

const saveToCache = (userData: any) => {
  if (import.meta.client && userData) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(userData))
    } catch {}
  }
}

const loadFromCache = (): any => {
  if (import.meta.client) {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY)
      return cached ? JSON.parse(cached) : null
    } catch {}
  }
  return null
}

const clearCache = () => {
  if (import.meta.client) {
    try {
      sessionStorage.removeItem(CACHE_KEY)
    } catch {}
  }
}

export const useAuth = () => {
  const user = useState('auth.user', () => null as any)
  const authReady = useState('auth.ready', () => false)

  const restoreFromCache = () => {
    const cached = loadFromCache()
    if (cached) {
      user.value = cached
    }
  }

  const login = async (email: string, password: string) => {
    try {
      const response = await $fetch('/api/auth/login', {
        method: 'POST',
        body: { email, password }
      }) as { success: boolean, user?: any, redirect?: string }

      if (response.success) {
        user.value = response.user
        saveToCache(response.user)

        const route = useRoute()
        const redirectTo = route.query.redirect as string

        if (redirectTo && redirectTo.startsWith('/')) {
          await navigateTo(redirectTo)
        } else if (response.redirect && response.redirect.startsWith('/')) {
          await navigateTo(response.redirect)
        } else {
          // No server-provided redirect: single-tenant home, else the org picker.
          await navigateTo(useRuntimeConfig().public.tenancy ? '/orgs' : '/')
        }

        return { success: true }
      }

      return { success: false, message: 'Login failed' }
    } catch (error: any) {
      return {
        success: false,
        message: error.data?.message || 'An error occurred during login'
      }
    }
  }

  const logout = async () => {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
      user.value = null
      clearCache()
      await navigateTo('/login')
    } catch {
      user.value = null
      clearCache()
      await navigateTo('/login')
    }
  }

  const register = async (email: string, password: string, display_name: string) => {
    try {
      const response = await $fetch('/api/auth/register', {
        method: 'POST',
        body: { email, password, display_name }
      }) as { success: boolean, message?: string, requiresVerification?: boolean, autoLoggedIn?: boolean, user?: any }

      // First-ever user is promoted server-side and arrives already logged in.
      if (response.autoLoggedIn && response.user) {
        user.value = response.user
        saveToCache(response.user)
      }

      return response
    } catch (error: any) {
      return {
        success: false,
        message: error.data?.statusMessage || error.data?.message || 'Registration failed'
      }
    }
  }

  const checkAuth = async () => {
    try {
      const response = await $fetch('/api/auth/me') as { user: any }
      user.value = response.user
      saveToCache(response.user)
      return response.user
    } catch {
      user.value = null
      clearCache()
      return null
    }
  }

  const isLoggedIn = computed(() => !!user.value)

  // Without a password the server requires a recent re-authentication; wrap
  // the call in `useReauth().withReauth` to prompt for it.
  const deleteAccount = async (password?: string) => {
    try {
      const response = await $fetch('/api/profile/account', {
        method: 'DELETE',
        body: password ? { password } : {}
      }) as { success: boolean, message?: string }

      if (response.success) {
        user.value = null
        clearCache()
        await navigateTo('/login')
        return { success: true }
      }

      return { success: false, message: 'Account deletion failed' }
    } catch (error: any) {
      if (error?.data?.data?.reauth) throw error
      return {
        success: false,
        message: error.data?.statusMessage || 'An error occurred while deleting your account'
      }
    }
  }

  return {
    user: readonly(user),
    authReady: readonly(authReady),
    login,
    logout,
    register,
    checkAuth,
    restoreFromCache,
    isLoggedIn,
    deleteAccount,
    setAuthReady: (value: boolean) => { authReady.value = value }
  }
}
