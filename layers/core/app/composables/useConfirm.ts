import { ConfirmModal } from '#components'

interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  color?: 'error' | 'primary'
}

// Opens ConfirmModal; resolves true when the user confirms, false when they cancel or dismiss it.
export function useConfirm() {
  const overlay = useOverlay()
  return async (options: ConfirmOptions): Promise<boolean> =>
    (await overlay.create(ConfirmModal, { destroyOnClose: true }).open(options)) === true
}
