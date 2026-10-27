// Open state for a settings row's panel. One panel is open at a time across
// the page; it closes when its row unmounts.
export function useSettingsRow(id: string) {
  const openId = useState<string | null>('settings-open-row', () => null)
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

// Older name, kept for hosts' own account pages.
export const useAccountRow = useSettingsRow
