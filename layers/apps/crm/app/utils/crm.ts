// Shared crm types for client and server, served by the `#crm` alias. The
// record vocabulary itself (field kinds, manifests) comes from `#records`.

/** A channel entry as it appears on a hydrated record's communication_channel field. */
export interface CrmChannelEntry {
  /** crm_contact_channels row id (the link). */
  linkId: string
  /** crm_channels row id (the shared address entity). */
  channelId: string
  channelType: string
  value: string
  label: string | null
  isPrimary: boolean
  verified: boolean
}

/**
 * Channel types whose addresses a linked user account owns: on a record with
 * a linked account (records_entries.user_id) they are read-only in the CRM.
 */
export const ACCOUNT_OWNED_CHANNEL_TYPES: readonly string[] = ['email']
