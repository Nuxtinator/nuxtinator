# CRM Layer

A Nuxt layer that adds a generic record kernel, a code-shipped **contacts** record type, and a default CRM UI (list, detail, timeline, schema builder). Works single-tenant out of the box; org-scoped via the standard tenancy retrofit when `@nuxtinator/tenancy` is loaded.

## Data model

Fifteen tables in four groups: **records** (`crm_records` with promoted `name`/`status` columns and a jsonb `data` bag, plus `crm_record_field_entries`, `crm_record_user_refs`, `crm_record_connections`, `crm_record_shares` for the multi-value storage classes), **channels** (`crm_channels` — one row per distinct address, shared by every record that links it through `crm_contact_channels`; `crm_channel_types` for admin-created types), **compliance** (`crm_channel_consents` as current state per channel+purpose, `crm_consent_events` as the append-only proof log that survives channel erasure via value snapshot + fingerprint, `crm_channel_suppressions` for bounces/complaints/manual blocks), and **presentation** (`crm_record_activity`, `crm_record_comments`, and the override tables `crm_record_types` / `crm_record_fields`). See [migrations/](migrations/) — `crm_001`–`crm_012` plus the tenancy retrofits `crm_T001` (org_id + RLS) and `crm_T002` (org-scoped uniques).

A record can carry `user_id`, the user account of the person it describes (`crm_011`, rescoped per org by `crm_T003`; one record per type per user). A linked record's name and email addresses belong to that account: the host app copies them onto the record (through `applyFieldPatch` and the channel functions, which stay open to it), and the CRM's routes and detail page refuse to change them ([server/utils/account-link.ts](server/utils/account-link.ts)). Which address types are locked comes back on the record as `accountOwnedChannelTypes`. Consent, an address's label and primary flag, and every other field stay editable.

Where a field's values live is decided by its kind (`storageOf` in [app/utils/crm-manifest.ts](app/utils/crm-manifest.ts)): promoted column, jsonb key, entry rows, user refs, connection edges, or the channel service.

## Extension points for other layers

Register from a Nitro plugin (same idiom as core's registries):

```ts
import {
  registerCrmRecordType,     // a manifest: fields, sections, statusField
  registerCrmChannelType,    // { typeKey, label, icon, valueFormat }
  registerCrmConsentPurpose, // 'marketing', 'transactional', ...
  registerCrmFieldFilter     // patch-rewrite hook, phase 'create' | 'update'
} from '#crm/server'
```

Typed record shapes come from `declare module '#crm'` — widen `CrmRecordTypeRegistry` with `InferRecordShape<typeof yourManifest>` (see [app/utils/manifests/contacts.ts](app/utils/manifests/contacts.ts)).

`#crm/server` also exposes the kernel services consumer layers (inbox, marketing, forms) call in-process — every function takes the caller's tenant transaction:

- `listRecords`, `getRecord`, `applyFieldPatch`, `deleteRecord`, `hydrateRecords`
- `claimChannel` / `findChannel` / `linkChannel` / `unlinkChannel` — get-or-create address identities and record links
- `grantConsent` / `revokeConsent` / `getConsentState` / `getConsentEvents`
- `canSend(tx, { channelType, normalizedValue, purpose })` — **the** delivery gate: claimed + opted in + not suppressed
- `suppress` / `clearSuppression` / `isSuppressed` (producers arrive with sender layers)
- `getRecordTypes` / `getRecordTypeFields` / `getChannelTypes` — merged definitions (code ⊳ DB overrides)

## Permissions

`crm.access` gates the app. The code-declared contacts type carries granular slugs (`crm.contacts.{read,create,update,delete,share,view_all}`); every other type — admin-created customs included — shares the generic `crm.records.*` set, because permission slugs are code-owned and runtime types can't mint them (`permFor(typeKey, action)` resolves). Slugs are the default policy, not the whole answer: the per-type evaluator (`resolveTypePermission` from `#crm/server`) first passes admins, then direct per-user grants (slug-level, additive — a role deny can never subtract them), then each of the caller's roles, where an explicit per-type row (stored on the type under `config.roleGrants`, edited in the roles × actions matrix at `/crm/settings/permissions`) overrides the role's slugs in either direction and no row falls back to them. Without `view_all`, a caller sees only records they created, records shared with them, or records referencing them through a user field; shares carry a level (`view` | `edit`) and an edit share grants update on exactly that record. Responses ship server-evaluated capability flags (`canRead`/`canCreate` per type, `canEdit`/`canShare`/`canDelete` per record) that the UI gates on. `crm.schema.manage` gates the schema builder and the permissions surface. `crm.read` / `crm.write` say what connected apps (MCP / OAuth clients) may do for the user, across every type. Default grants: members get read/create/update/share plus `crm.read` / `crm.write`; org admins get everything.

## Closing records

Records are archived by closing them, D.T style. A status option flagged `closed` (contacts' Closed, set in code; admins mark their own in the schema builder's status options) means the record is closed; a type with no such option can't be closed, and admin-created types have no status field. A type can name a closed-reason field (`closedReasonField` on the manifest, or picked on the type's settings page): closing then requires a reason, editing a record that is already closed doesn't, and reopening clears the reason. Contacts ship `reason_closed`. A reason option flagged `revokesConsent` in code (contacts' "Asked to be removed") revokes every opted-in consent on the record's addresses as normal consent events; consent belongs to the address, so records sharing it lose it too. `applyFieldPatch` applies these rules (see [server/utils/closing.ts](server/utils/closing.ts)), so the routes, the MCP tools and other layers all share them.

## MCP tools

When the MCP layer is loaded, [modules/crm-mcp.ts](modules/crm-mcp.ts) registers the tools in [mcp/crm-tools.ts](mcp/crm-tools.ts):

| Tool | Scope | |
|---|---|---|
| `crm_list_record_types` | `crm.read` | read-only |
| `crm_search_records` | `crm.read` | read-only; closed records only with `includeClosed` |
| `crm_get_record` | `crm.read` | read-only; channels with consent state |
| `crm_list_timeline` | `crm.read` | read-only |
| `crm_create_record` | `crm.write` | |
| `crm_update_record` | `crm.write` | |
| `crm_close_record` | `crm.write` | reason required when the type has a reason field |
| `crm_add_comment` | `crm.write` | |
| `crm_link_channel` / `crm_unlink_channel` | `crm.write` | address by value |
| `crm_set_consent` | `crm.write` | requires `source` and `evidence` |

`crm.read` / `crm.write` are what a connected app may do; inside a tool the same per-type checks as the HTTP routes decide which records it can touch (type grants, visibility, edit shares). Tools take an optional `org` slug and run in `withOrgPermission`, so the tenant context carries the OAuth client: timeline rows and comments store it in `client_id` (`crm_012`) and show "via <app>", and consent events record it in their meta. Writes return each changed field's before/after value. No tool grants consent as a side effect, and there is no delete tool.

## Admin customization

`/crm/settings` (gated by `crm.schema.manage`) lets org admins create record types, add custom fields (kinds whose storage is jsonb/entries, plus `communication_channel` with a channel type from the merged catalog), relabel/reorder/hide code-shipped schema, and manage channel types. Storage is overrides-only: `crm_record_types` / `crm_record_fields` rows hold either admin-created definitions (`is_custom` / `kind` set) or the delta against the code manifest — a value equal to the code default is never persisted, and a fully-reverted row is deleted. Admin-created types and fields are deliberately orphan rows in the merged readers; stale orphans (rows whose code definition was removed) surface only to schema managers.

## Channels, consent, suppression

An address (`email`, `phone`, custom types) is a **shared identity**: one `crm_channels` row per normalized value, linked to any number of records. Editing a value on a record claims the new address and relinks — identity rows are never mutated, because consent and suppression state hang off them. Consent is keyed to the channel, not the record: one opt-out covers every record holding that address. State changes are idempotent (re-asserting writes no event) and each real change appends one compliance event carrying the literal value snapshot and a `sha256(kind:normalized)` fingerprint, so the proof outlives erasure. Suppressions are first-write-wins per channel; only `manual` ones are clearable. Senders never check any of this piecemeal — they call `canSend`.

## Development

Host wiring, tests, and seeds follow the monorepo conventions: `bun run test -- --project crm` from `dev/` runs the layer's vitest project; `bun run seed` seeds eight demo contacts with channels, consents, a shared address, a relation pair, and comments.
