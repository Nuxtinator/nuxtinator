# CRM Layer

The contacts app on top of [`@nuxtinator/records`](../../records/): the code-shipped **contacts** record type, communication channels (address identities shared across records), consent per channel and purpose, suppression, and the contacts UI under `/crm/contacts`. Record storage, sharing, comments, the schema builder and the list/detail views are the records layer's.

## Data model

Six tables: `crm_channels` (one row per distinct address, shared by every record that links it through `crm_contact_channels`), `crm_channel_types` (admin-created channel types), `crm_channel_consents` (current state per channel+purpose), `crm_consent_events` (the append-only proof log, which survives channel erasure via a value snapshot + fingerprint) and `crm_channel_suppressions`. The tenancy retrofits `crm_T001`–`crm_T003` predate the records layer and also cover the kernel tables under their old names.

## How crm plugs into records

- A storage driver for `communication_channel` fields ([server/utils/channel-storage.ts](server/utils/channel-storage.ts)): hydration, filters, search and writes go through the channel service.
- A closing hook ([server/utils/consent-on-close.ts](server/utils/consent-on-close.ts)): closing a contact with a reason flagged `revokesConsent` ("Asked to be removed") revokes every opted-in consent on its addresses.
- A patch guard ([server/utils/account-link.ts](server/utils/account-link.ts)): a contact linked to a user account takes its name and email addresses from that account, so the record routes refuse to change them.
- Client registrations ([app/plugins/register-crm-ui.ts](app/plugins/register-crm-ui.ts)): contacts live under `/crm/contacts`, channel fields render through the channel widget, the schema builder picks a channel type for new channel fields, and the records settings page lists channel types.

Contacts carry their own slugs (`crm.contacts.*`, plus `crm.access` for the app) and opt out of board-granted visibility: putting a contact on a shared board never widens who can see that person.

## Server surface

`#crm/server` exports the channel functions (`claimChannel`, `findChannel`, `linkChannel`, `unlinkChannel`, …), consent (`grantConsent`, `revokeConsent`, `getConsentState`, `getConsentEvents`, `canSend` — **the** delivery gate), suppression, and the channel-type catalog. Register more channel types and consent purposes with `registerCrmChannelType` / `registerCrmConsentPurpose`.

## MCP tools

`crm_get_addresses` (`records.read`), `crm_link_channel`, `crm_unlink_channel`, `crm_set_consent` (`records.write`; consent requires `source` and `evidence`). Record reads and writes are the records layer's tools.

## Channels, consent, suppression

An address (`email`, `phone`, custom types) is a **shared identity**: one `crm_channels` row per normalized value, linked to any number of records. Editing a value on a record claims the new address and relinks — identity rows are never mutated, because consent and suppression state hang off them. Consent is keyed to the channel, not the record: one opt-out covers every record holding that address. State changes are idempotent (re-asserting writes no event) and each real change appends one compliance event carrying the literal value snapshot and a `sha256(kind:normalized)` fingerprint, so the proof outlives erasure. Suppressions are first-write-wins per channel; only `manual` ones are clearable. Senders never check any of this piecemeal — they call `canSend`.

## Development

Host wiring, tests, and seeds follow the monorepo conventions: `bun run test -- --project crm` from `dev/` runs the layer's vitest project; `bun run seed` seeds eight demo contacts with channels, consents, a shared address, a relation pair, and comments.
