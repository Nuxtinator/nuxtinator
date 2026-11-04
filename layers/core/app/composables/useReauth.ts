// Step-up re-authentication for sensitive actions. Wrap the request in
// `withReauth`: when the server answers 403 with `data.reauth`, a
// `<ReauthModal />` (which the page must render) asks the user to confirm with
// their password; on success the request is retried once. Provider sign-in
// from the modal leaves the page and comes back, after which the user repeats
// the action.
let pending: ((ok: boolean) => void) | null = null

export function useReauth() {
  const open = useState('reauth.open', () => false)

  function requestReauth(): Promise<boolean> {
    open.value = true
    return new Promise((resolve) => {
      pending = resolve
    })
  }

  function settle(ok: boolean) {
    open.value = false
    const resolve = pending
    pending = null
    resolve?.(ok)
  }

  async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: any) {
      if (err?.data?.data?.reauth && await requestReauth()) {
        return await fn()
      }
      throw err
    }
  }

  return { open, withReauth, settle }
}
