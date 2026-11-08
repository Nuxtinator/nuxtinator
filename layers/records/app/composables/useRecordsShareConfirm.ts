// Runs a write that may name someone in an access-granting people field (an
// assignee) who can't see the record yet. The server refuses such a write
// with a 409 (`records.share_confirmation`); this asks the user, then resends
// it confirmed. Resolves to the write's result, or undefined when the user
// declines.

/** `data.code` of the server's 409 for a write that would share a record unconfirmed. */
export const RECORDS_SHARE_CONFIRMATION = 'records.share_confirmation'

export interface RecordsShareConfirmationError {
  statusMessage: string
  users: Array<{ id: string, name: string }>
}

/** The share-confirmation details of a failed $fetch, or null for any other error. */
export function recordsShareConfirmation(err: unknown): RecordsShareConfirmationError | null {
  const body = (err as { data?: { statusMessage?: string, data?: { code?: string, users?: Array<{ id: string, name: string }> } } } | null)?.data
  if (body?.data?.code !== RECORDS_SHARE_CONFIRMATION) return null
  return { statusMessage: body.statusMessage ?? '', users: body.data.users ?? [] }
}

export function useRecordsShareConfirm() {
  const confirmAction = useConfirm()
  return async <T>(write: (confirmShare: boolean) => Promise<T>): Promise<T | undefined> => {
    try {
      return await write(false)
    } catch (err) {
      const details = recordsShareConfirmation(err)
      if (!details) throw err
      const names = details.users.map(u => u.name).join(', ')
      const ok = await confirmAction({
        title: `Share with ${names || 'them'}?`,
        description: details.statusMessage,
        confirmLabel: 'Assign and share',
        color: 'primary'
      })
      if (!ok) return undefined
      return await write(true)
    }
  }
}
