# CRM Layer

A Nuxt layer that adds a generic record kernel, a code-shipped **contacts** record type, and a default CRM UI (list, detail, timeline, schema builder). Works single-tenant out of the box; org-scoped via the standard tenancy retrofit when `@nuxtinator/tenancy` is loaded.

## Data model

Fifteen tables in four groups: **records** (`crm_records` with promoted `name`/`status` columns and a jsonb `data` bag, plus `crm_record_field_entries`, `crm_record_user_refs`, `crm_record_connections`, `crm_record_shares` for the multi-value storage classes), **channels** (`crm_channels` — one row per distinct address, shared by every record that links it through `crm_contact_channels`; `crm_channel_types` for admin-created types), **compliance** (`crm_channel_consents` as current state per channel+purpose, `crm_consent_events` as the append-only proof log that survives channel erasure via value snapshot + fingerprint, `crm_channel_suppressions` for bounces/complaints/manual blocks), and **presentation** (`crm_record_activity`, `crm_record_comments`, and the override tables `crm_record_types` / `crm_record_fields`). See [migrations/](migrations/) — `crm_001`–`crm_008` plus the tenancy retrofits `crm_T001` (org_id + RLS) and `crm_T002` (org-scoped uniques).

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

`crm.access` gates the app. The code-declared contacts type carries granular slugs (`crm.contacts.{read,create,update,delete,share,view_all}`); every other type — admin-created customs included — shares the generic `crm.records.*` set, because permission slugs are code-owned and runtime types can't mint them (`permFor(typeKey, action)` resolves). Slugs are the default policy, not the whole answer: the per-type evaluator (`resolveTypePermission` from `#crm/server`) first passes admins, then direct per-user grants (slug-level, additive — a role deny can never subtract them), then each of the caller's roles, where an explicit per-type row (stored on the type under `config.roleGrants`, edited in the roles × actions matrix at `/crm/settings/permissions`) overrides the role's slugs in either direction and no row falls back to them. Without `view_all`, a caller sees only records they created, records shared with them, or records referencing them through a user field; shares carry a level (`view` | `edit`) and an edit share grants update on exactly that record. Responses ship server-evaluated capability flags (`canRead`/`canCreate` per type, `canEdit`/`canShare`/`canDelete` per record) that the UI gates on. `crm.schema.manage` gates the schema builder and the permissions surface. Default grants: members get read/create/update/share; org admins get everything.

## Admin customization

`/crm/settings` (gated by `crm.schema.manage`) lets org admins create record types, add custom fields (kinds whose storage is jsonb/entries, plus `communication_channel` with a channel type from the merged catalog), relabel/reorder/hide code-shipped schema, and manage channel types. Storage is overrides-only: `crm_record_types` / `crm_record_fields` rows hold either admin-created definitions (`is_custom` / `kind` set) or the delta against the code manifest — a value equal to the code default is never persisted, and a fully-reverted row is deleted. Admin-created types and fields are deliberately orphan rows in the merged readers; stale orphans (rows whose code definition was removed) surface only to schema managers.

A host that doesn't offer the schema builder and permissions matrix sets `crm: { schemaAdmin: false }` in its `app.config.ts`. Their links and pages stay hidden whatever the user's permissions; the server still enforces `crm.schema.manage`.

## Channels, consent, suppression

An address (`email`, `phone`, custom types) is a **shared identity**: one `crm_channels` row per normalized value, linked to any number of records. Editing a value on a record claims the new address and relinks — identity rows are never mutated, because consent and suppression state hang off them. Consent is keyed to the channel, not the record: one opt-out covers every record holding that address. State changes are idempotent (re-asserting writes no event) and each real change appends one compliance event carrying the literal value snapshot and a `sha256(kind:normalized)` fingerprint, so the proof outlives erasure. Suppressions are first-write-wins per channel; only `manual` ones are clearable. Senders never check any of this piecemeal — they call `canSend`.

## Development

Host wiring, tests, and seeds follow the monorepo conventions: `bun run test -- --project crm` from `dev/` runs the layer's vitest project; `bun run seed` seeds eight demo contacts with channels, consents, a shared address, a relation pair, and comments.
