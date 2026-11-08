# Records Layer

The record kernel: record types and their fields, the records themselves, and everything generic about them — storage, the list engine, sharing, comments, activity, closing, the schema builder, and a `/records` app for browsing any type. Other layers build on it: `crm` adds contacts with communication channels and consent, `views` adds kanban boards and tables, producer layers (meetings) write tasks. Works single-tenant out of the box; org-scoped with `@nuxtinator/tenancy`.

## Data model

Eleven tables: `records_entries` (one row per record of any type, with promoted `name`/`status` columns and a jsonb `data` bag), the multi-value storage classes `records_field_entries`, `records_user_refs`, `records_connections`, `records_attachments` (files on attachments fields, bytes in private object storage), plus `records_shares`, `records_activity`, `records_comments`, the schema-builder override tables `records_types` / `records_fields`, and `records_attachment_trash` (storage keys of deleted files, emptied by a background sweep). The first nine were created as `crm_*` by `crm_001`–`crm_012` (kept under their original names in [migrations/](migrations/)) and renamed by `records_001`; `records_T001` scopes them per org on hosts without the crm layer. `records_003` / `records_T002` add the attachment tables.

A record can carry `user_id`, the user account of the person it describes (one record per type per user).

Where a field's values live is decided by its kind (`storageOf` in [app/utils/records-manifest.ts](app/utils/records-manifest.ts)): promoted column, jsonb key, entry rows, user refs, connection edges, attachment rows, or a registered storage driver (`channels`, provided by crm).

## Attachments

An `attachments` field holds uploaded files. They arrive through `POST /api/records/entries/:type/:id/attachments?field=<key>` (multipart, 25 MB a file, 50 a field), never through a field patch; a patch only reorders or removes them. Hydrated values are `{ id, name, mime, size, url }`, with a signed link that stays the same for six hours so browsers cache images. Only PNG, JPEG, GIF, WebP and AVIF open in the browser; every other file downloads as a plain byte stream, so an uploaded HTML or SVG page can't run. An attachments field can't be required, since files arrive after the record exists. A card layout may name an attachments field as its `cover`: boards show its first image on top of each card. Deleting a file, or its record, queues the stored object for deletion. Other layers keep files for their own per-record fields in the same table under a namespaced field key (`views:<viewId>:<fieldKey>`), through `addRecordAttachment` / `listRecordAttachments` / `deleteRecordAttachments`.

## Status

Every record type has a status field, so every record can be closed. A type whose code declares no status column (items, admin-created types) gets the default one, Open / Done with Done closed ([definition-settings.ts](server/utils/definition-settings.ts) → `RECORDS_DEFAULT_STATUS_FIELD`). Admins rename it and add, relabel, recolor or remove options in the schema builder; the field can't be hidden, and a status always keeps at least one open and one closed option. A record with no stored status reads, filters and sorts as the field's default.

## Built-in types

`item` — a freeform card: name, notes, tags, link, date, people, priority (low / medium / high), attachments (its first image is the card cover) and the default Open / Done status. People only records who's involved: naming someone doesn't share the item.

`task` — name, status (To do / In progress / Done, keyed `open` / `in_progress` / `done`; done is closed), assignee, priority (low to urgent), start and due dates, tags, parent task with subtasks (cards show subtask progress), description and attachments.

Orgs hide the fields they don't want from the schema builder, and can hide either type. Members hold no `view_all`, so items and tasks are personal by default: a caller sees records they created, records shared with them, tasks assigned to them, and records on hand-picked views they can open (see Visibility).

## Extension points

Server, from a Nitro plugin, via `#records/server`:

- `registerRecordType(manifest)` — a code-declared type. A manifest may name `permissionPrefix` (its own slug namespace; contacts use `crm.contacts`), `app` (the app whose per-org switch gates its records), `boardsGrantVisibility: false` (opt out of board-granted visibility), and a default `card` layout (with an optional `cover` attachments field). A `user_select` field with `grantsAccess: true` lets the people it names see the record.
- `registerRecordFieldExtension(typeKey, owner, fields)` — add fields to a type another layer owns.
- `registerRecordsStorageDriver(driver)` — implement a storage class (hydrate, filter, search, validate, write).
- `registerRecordsClosingHook(fn)` — run when a record closes.
- `registerRecordsPatchGuard(fn)` — refuse a PATCH through the record route.
- `registerRecordsVisibilitySource(source)` — another way a caller may see a record; with `editPredicate` it also lets them edit it, and `describe` lists it on the record's share list.
- `registerRecordsFieldFilter(phase, fn)` — rewrite a patch before validation.

Client, from a Nuxt app plugin, via `#records`: `registerRecordsDetailPanel`, `registerRecordsFieldWidget` (replace a kind's row on the detail page), `registerRecordsFieldKindSettings` (extra schema-builder inputs for a kind), `registerRecordsSettingsSection`, `registerRecordsTypeRoute` (give a type its own home, e.g. contacts under `/crm/contacts`). `#records/client` exports the client field settings, formatters and badge colors; `ListView` / `DetailView` components render any type.

## Visibility

Without `<type>.view_all`, a caller sees records they created, records shared with them, records naming them in an access-granting people field (`grantsAccess`: task's assignee, contacts' assigned to), and whatever registered visibility sources grant — the views layer grants the cards of hand-picked views the caller can open, and edit on them at 'edit' — for types whose `boardsGrantVisibility` isn't false. Other people fields only record who's involved. Anyone who holds the type's read and can see a record can comment on it.

Naming someone in an access-granting field who can't otherwise see the record shares it with them, so writes a person makes ask first: the record routes refuse such a write with a 409 whose `data.code` is `records.share_confirmation` (with the people it names) until it's resent with `confirmShare: true`, and the MCP write tools want `share: true`. `applyFieldPatch(…, { sharing: 'ask' | 'confirmed' })` and `requireShareConfirmation` do the check for other layers; system writes leave it out. In the UI, `useRecordsShareConfirm()` asks and resends.

## Permissions

`records.access` gates the app. Types without their own namespace share `records.entries.{read,create,update,delete,share,view_all}`; the per-type evaluator (`resolveTypePermission`) layers direct user grants, per-type role rows and per-type team rows (`config.teamGrants`, which only add) on top. `records.schema.manage` gates the schema builder; `records.read` / `records.write` say what connected apps may do. Default grants: members get read/create/update/share plus `records.read` / `records.write`; org admins get everything.

## MCP tools

| Tool | Scope |
|---|---|
| `records_list_types`, `records_search`, `records_get`, `records_list_timeline` | `records.read` |
| `records_create`, `records_update` (`share: true` to assign someone who can't see the record yet), `records_close`, `records_add_comment` | `records.write` |
| `records_create_type`, `records_add_field`, `records_update_field` | `records.schema.manage` |

The schema tools tell agents to reuse or extend an existing type before creating one. Admin-created connection fields are forward-only.

## Development

`bun run test -- --project records` from `dev/`.
