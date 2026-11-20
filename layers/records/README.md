# Records Layer

The record kernel: record types and their fields, the records themselves, and everything generic about them — storage, the list engine, sharing, comments, activity, closing, the schema builder, and a `/records` app for browsing any type. Other layers build on it: `crm` adds contacts with communication channels and consent, `views` adds kanban boards and tables, producer layers (meetings) write tasks and point them at their own rows with `ref` fields. Works single-tenant out of the box; org-scoped with `@nuxtinator/tenancy`.

## Data model

Twelve tables: `records_entries` (one row per record of any type, with promoted `name`/`status` columns and a jsonb `data` bag), the multi-value storage classes `records_field_entries`, `records_user_refs`, `records_connections`, `records_attachments` (files on attachments fields, bytes in private object storage), plus `records_shares`, `records_activity`, `records_comments`, the schema-builder override tables `records_types` / `records_fields`, `records_attachment_trash` (storage keys of deleted files, emptied by a background sweep), and `records_reminders` (the reminder queue, see Reminders). The first nine were created as `crm_*` by `crm_001`–`crm_012` (kept under their original names in [migrations/](migrations/)) and renamed by `records_001`; `records_T001` scopes them per org on hosts without the crm layer. `records_003` / `records_T002` add the attachment tables, `records_006` / `records_T004` the reminder queue.

A record can carry `user_id`, the user account of the person it describes (one record per type per user).

Where a field's values live is decided by its kind (`storageOf` in [app/utils/records-manifest.ts](app/utils/records-manifest.ts)): promoted column, jsonb key, entry rows, user refs, connection edges, attachment rows, or a registered storage driver (`channels`, provided by crm).

## Refs

A `ref` field points at one thing another layer owns, not a record: a task's meeting. It stores the target's id as a jsonb key and names a `source` the owning layer registers with `registerRecordsRefSource({ source, label, resolve, search })`. `resolve` turns ids into `{ label, url }` for the caller (or says a target is hidden); `search` feeds the picker. A ref reads back as `{ id, label, url }`, or `{ id, label: '', hidden: true }` / `{ id, label: '', missing: true }` when the caller can't see the target or it's gone. Writes accept only targets the caller can see; a value the record already holds is left alone. Filters offer is / is not / empty / not empty. `GET /api/records/refs/:source?q=` lists targets for pickers; `?ids=` resolves chosen ones. Ref fields are code-declared only (the schema builder doesn't offer them), usually added to another layer's type with `registerRecordFieldExtension`.

## Attachments

An `attachments` field holds uploaded files. They arrive through `POST /api/records/entries/:type/:id/attachments?field=<key>` (multipart, 25 MB a file, 50 a field), never through a field patch; a patch only reorders or removes them. Hydrated values are `{ id, name, mime, size, url }`, with a signed link that stays the same for six hours so browsers cache images. Only PNG, JPEG, GIF, WebP and AVIF open in the browser; every other file downloads as a plain byte stream, so an uploaded HTML or SVG page can't run. An attachments field can't be required, since files arrive after the record exists. A card layout may name an attachments field as its `cover`: boards show its first image on top of each card. Deleting a file, or its record, queues the stored object for deletion. Other layers keep files for their own per-record fields in the same table under a namespaced field key (`views:<viewId>:<fieldKey>`), through `addRecordAttachment` / `listRecordAttachments` / `deleteRecordAttachments`.

## Status

Every record type has a status field, so every record can be closed. A type whose code declares no status column (items, admin-created types) gets the default one, Open / Done with Done closed ([definition-settings.ts](server/utils/definition-settings.ts) → `RECORDS_DEFAULT_STATUS_FIELD`). Admins rename it and add, relabel, recolor or remove options in the schema builder; the field can't be hidden, and a status always keeps at least one open and one closed option. A record with no stored status reads, filters and sorts as the field's default.

## Tags

Every record type has a tags field under the key `tags`, always shown. A type whose code declares no `tags` field gets the default one (`RECORDS_DEFAULT_TAGS_FIELD`); a manifest that declares its own places it. Admins can rename it but not hide it, and no other field can take the key. As someone types a tag, the field suggests the tags already on that type's records they can see, most used first, and offers Create only when what's typed matches none of them in any case (`GET /api/records/entries/:type/tags?field=&q=`, `listRecordsTagValues`).

## Due dates

A type names its due-date field with `dueField` (a manifest key, or picked in the schema builder; tasks use `due_date`). A type with one also has a `reminder` field and a `repeat` field; other types have neither. Both count from the due date, so setting either without one is refused, and clearing the due date clears them ([due-date.ts](server/utils/due-date.ts)).

## Reminders

The `reminder` field (`RECORDS_REMINDER_FIELD`) says how long before the due date to remind: on the due date, 1 or 3 days, 1 or 2 weeks, or 1 or 3 months before. The day it falls on goes into `records_reminders`, and moves whenever the due date or the option changes; a day already past isn't queued. A sweep that runs every minute ([reminders.ts](server/utils/reminders.ts)) sends the reminders whose day has come (UTC): "Reminder: ‹name›", in the app and by email, to the record's assignees (its access-granting people fields), or to whoever set the reminder when it has none, among those who can open the record. A closed record's reminder is dropped unsent. Under tests the sweep runs through `POST /api/_test/records-reminders`.

## Repeat

The `repeat` field (`RECORDS_REPEAT_FIELD`) is every week, month, 3 months or year.

Closing a record that repeats makes the next one ([repeat.ts](server/utils/repeat.ts)): a copy with the type's default status, its due date moved forward by whole intervals from the old one until it isn't past (a report due 15 Jan comes back 15 Apr, 15 Jul, …), and its other dates moved by the same amount. Its reminder counts from the new due date. The copy keeps the creator, field values, assignees, links, tags, parent and shares, takes copies of the files (rich text images point at the copies), and its subtasks are copied the same way, back to their default status. Comments and activity start fresh. The closed record stops repeating, and both records note the other in their activity. `registerRecordsRepeatHook` lets other layers carry their own per-record state over (the views layer puts the copy on the same hand-picked views).

## Built-in types

`item` — a freeform card: name, notes, tags, link, date, people, priority (low / medium / high), attachments (its first image is the card cover) and the default Open / Done status. People only records who's involved: naming someone doesn't share the item.

`task` — name, status (To do / In progress / Done, keyed `open` / `in_progress` / `done`; done is closed), assignees (one or more people; a write may give a single user id in place of the list), priority (low to urgent), start and due dates, repeat, reminder, tags, parent task with subtasks (cards show subtask progress), description (rich text) and attachments. Tasks nest to any depth; see Hierarchies.

## Hierarchies

A type whose manifest marks a connection to itself with `hierarchy: 'parent'` (and its `reverseKey` pair with `hierarchy: 'children'`) arranges its records in trees: tasks do, through `parent` / `subtasks`.

An org can also nest one type under another in the schema builder: a connection field created with a Nesting choice (`nesting: 'children'` or `'parent'` on `POST …/schema/types/:type/fields`) makes a field on each type, e.g. "Tasks" on an org's own Deliverables type and "Deliverable" on tasks. A tree can then mix types: a deliverable, its tasks, their subtasks. The choice is made when the field is created and can't be changed after. Deleting either field deletes the other and the links, and the records that sat under a parent through it become top-level. The key of the field naming the parent must not be used by a connection on any other type.

- A record has one parent, of its own type or another. Writing either field of a pair sets it, a record with two kinds of parent field (a task's parent task and its deliverable) leaves one when put under the other, and a record can't be put under itself or under anything below it.
- Access comes down across types: whoever sees a deliverable sees its tasks, by the deliverable type's own rules (its shares, its views, and `view_all` on it). The type's read permission still applies to each record.
- Whoever can see or edit a record can see or edit everything under it. Sharing a big task, assigning it, or putting it on a hand-picked view shares its whole breakdown; a task with no shared ancestor stays as private as before.
- Moving an existing record under one other people can see asks first, like assigning someone does (`records.share_confirmation`, with a `title` and `confirmLabel` and no `users`). It asks when any record the move puts above it is shared, assigned or on a shared view, so a move from a private branch to a shared branch of the same tree asks too. It doesn't ask when everyone in the org holds `view_all` on the moved record's type, since they already see it and everything under it. Creating a record under a parent doesn't ask, and neither does a move that puts nothing new above the record.
- Moves in an org run one at a time (`lockRecordsHierarchy`), so two at once can't make a loop or leave a record with two parents.
- A record's share list (`GET …/shares`, `via`) also lists what shares each record above it that the caller can see: the people it's shared with or assigned to (`sourceId: 'records:ancestor'`) and the views holding it (`through` names the record).
- Linking a record from its parent's side takes the right to see and edit that record.
- Filters: "Parent is empty" keeps a list to the top level, "Subtasks is empty" to the leaves, and the parent field's "is anywhere under" (`op: 'under'`) matches at any depth.
- Deleting a record leaves what was under it as roots.

Orgs hide the fields they don't want from the schema builder, and can hide either type. Members hold no `view_all`, so items and tasks are personal by default: a caller sees records they created, records shared with them, tasks assigned to them, and records on hand-picked views they can open (see Visibility).

## Extension points

Server, from a Nitro plugin, via `#records/server`:

- `registerRecordType(manifest)` — a code-declared type. A manifest may name `permissionPrefix` (its own slug namespace; contacts use `crm.contacts`), `app` (the app whose per-org switch gates its records), `boardsGrantVisibility: false` (opt out of board-granted visibility), and a default `card` layout (with an optional `cover` attachments field). A `user_select` field with `grantsAccess: true` lets the people it names see the record; every people field an admin adds in the schema builder does. A connection to the type itself with `hierarchy: 'parent'` makes it a tree (see Hierarchies).
- `registerRecordFieldExtension(typeKey, owner, fields)` — add fields to a type another layer owns.
- `registerRecordsStorageDriver(driver)` — implement a storage class (hydrate, filter, search, validate, write).
- `registerRecordsClosingHook(fn)` — run when a record closes.
- `registerRecordsRepeatHook(fn)` — run for each record a repeat copies (see Repeat).
- `registerRecordsPatchGuard(fn)` — refuse a PATCH through the record route.
- `registerRecordsVisibilitySource(source)` — another way a caller may see a record; with `editPredicate` it also lets them edit it, and `describe` lists it on the record's share list.
- `registerRecordsFieldFilter(phase, fn)` — rewrite a patch before validation.
- `registerRecordsRefSource(source)` — what a `ref` field's ids point at (see Refs).

Client, from a Nuxt app plugin, via `#records`: `registerRecordsDetailPanel`, `registerRecordsChildrenAction` (a control in the heading of a record's list of children; views puts the subtasks board link there), `registerRecordsFieldWidget` (replace a kind's row on the detail page), `registerRecordsFieldKindSettings` (extra schema-builder inputs for a kind), `registerRecordsSettingsSection`, `registerRecordsTypeRoute` (give a type its own home, e.g. contacts under `/crm/contacts`). `#records/client` exports the client field settings, formatters and badge colors; `ListView` / `DetailView` components render any type.

## Visibility

Without `<type>.view_all`, a caller sees records they created, records shared with them, records naming them in an access-granting people field (`grantsAccess`: task's assignee, contacts' assigned to, any people field an admin added), and whatever registered visibility sources grant — the views layer grants the cards of hand-picked views the caller can open, and edit on them at 'edit' — for types whose `boardsGrantVisibility` isn't false. On a type with a hierarchy, seeing a record by any of those also shows everything under it. Other people fields only record who's involved. Anyone who holds the type's read and can see a record can comment on it.

Naming someone in an access-granting field who can't otherwise see the record shares it with them, so writes a person makes ask first: the record routes refuse such a write with a 409 whose `data.code` is `records.share_confirmation` (with the people it names) until it's resent with `confirmShare: true`, and the MCP write tools want `share: true`. `applyFieldPatch(…, { sharing: 'ask' | 'confirmed' })` and `requireShareConfirmation` do the check for other layers; system writes leave it out. In the UI, `useRecordsShareConfirm()` asks and resends.

## Notifications

A person's write that newly mentions someone in a rich text field ("@" in a task's description) tells them the same way ("Jane mentioned you on a task"), but only if they can already open the record: a mention never shares it. A person's write that newly names someone in an access-granting people field (a task's assignee, a contact's assigned to) tells them, in the app and by email: "Jane assigned you a task", linking to the record. The writer is never told about their own change, and system writes (no `sharing` option) send nothing.

## Permissions

`records.access` gates the app. Types without their own namespace share `records.entries.{read,create,update,delete,share,view_all}`; the per-type evaluator (`resolveTypePermission`) layers direct user grants, per-type role rows and per-type team rows (`config.teamGrants`, which only add) on top. `records.schema.manage` gates the schema builder; `records.read` / `records.write` say what connected apps may do. Default grants: members get read/create/update/share plus `records.read` / `records.write`; org admins get everything.

## MCP tools

| Tool | Scope |
|---|---|
| `records_list_types`, `records_search`, `records_get`, `records_list_timeline` | `records.read` |
| `records_create`, `records_update` (`share: true` to assign someone who can't see the record yet, or to move a task under one other people can see), `records_close`, `records_add_comment` | `records.write` |
| `records_create_many`, `records_update_many`, `records_close_many`: up to 100 records in one call, which counts once against the MCP write limit. Each record runs in its own savepoint and is reported on its own; a share refusal on any of them saves nothing. | `records.write` |
| `records_create_type`, `records_add_field`, `records_update_field` (options, which statuses close a record, option order), `records_update_type` (label, icon, due-date field) | `records.schema.manage` |

The schema tools tell agents to reuse or extend an existing type before creating one. Admin-created connection fields are forward-only.

## Development

`bun run test -- --project records` from `dev/`.
