// Whether the auth pages should offer account creation. Assumes open until the
// server answers, so a failed request never hides sign-up on an open site.
export async function useRegistrationOpen() {
  const { data } = await useFetch<{ open: boolean }>('/api/auth/registration', { key: 'registration-open' })
  return computed(() => data.value?.open !== false)
}
