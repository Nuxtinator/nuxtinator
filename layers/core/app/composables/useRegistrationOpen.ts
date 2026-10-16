// Whether the auth pages should offer account creation. Hidden while a lazy
// request is in flight; if the request fails, sign-up stays visible and the
// server still refuses it on a closed site.
export async function useRegistrationOpen(opts: { lazy?: boolean } = {}) {
  const { data, error } = await useFetch<{ open: boolean }>('/api/auth/registration', {
    key: 'registration-open',
    lazy: opts.lazy
  })
  return computed(() => (data.value ? data.value.open : !!error.value))
}
