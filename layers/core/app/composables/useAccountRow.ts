// Open state for an account row's panel. One panel is open at a time across
// the account page; it closes when its row unmounts.
export function useAccountRow(id: string) {
  const openId = useState<string | null>('account-open-row', () => null)
  const open = computed(() => openId.value === id)

  const close = () => {
    if (openId.value === id) openId.value = null
  }
  const toggle = () => {
    openId.value = open.value ? null : id
  }

  onScopeDispose(close)

  return { open, toggle, close }
}
