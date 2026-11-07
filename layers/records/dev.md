# Records layer — maintainer notes

Working doc for sessions building on `@nuxtinator/records`. [README.md](README.md) is the
consumer-facing overview; this file records the *decisions*, their rationale, and the
traps. Contacts, channels and consent live in the crm layer
([../apps/crm/dev.md](../apps/crm/dev.md)).

## What this layer is

The generic **record kernel**: record types and fields, storage, the list engine,
sharing, comments, activity, closing, the schema builder, the built-in `item` and
`task` types, and a `/records` app. Other layers plug in through registries (crm adds
contacts and channels, views adds boards). Works in single-tenant mode and org-scoped
multi-tenant mode with no mode-conditional code — everything rides the tenant
transaction.

## Decision log (what we chose and why)

**Storage: one `records_entries` table, promoted hot columns + JSONB — not CTI, not EAV, not runtime DDL.**
Promoted real columns (`name`, `status`, `record_type`, timestamps) carry the fields
every list query filters/sorts on; all other single-value scalars live in the `data`
JSONB doc; multi-value kinds get row-per-value satellites. Full EAV (WordPress
postmeta, what D.T suffers under) pays a join per field on the hottest queries; pure
JSONB starves the planner on hot fields. Runtime DDL (Twenty-style) was rejected
because org-created types would need per-org DDL under shared-schema RLS. The storage
router keeps a per-type extension table (class-table inheritance) reachable later
without rearchitecting — a manifest could map its fields to real columns.

**One field-kind registry drives everything.** `storageOf()` + the kind vocabulary in
[app/utils/records-manifest.ts](app/utils/records-manifest.ts) decide storage,
validation, rendering (`app/utils/field-kinds.ts` dispatcher), and filter compilation.
D.T's plague of parallel hand-maintained type lists is the anti-pattern this exists to
avoid. Adding a kind touches the vocabulary + router + one renderer + one validator —
nothing else. A storage class the kernel doesn't implement (crm's `channels`) comes in
through `registerRecordsStorageDriver`.

**Definitions: code manifests ⊳ org-scoped DB overrides (defineSettings).**
Code-shipped types are `registerRecordType(manifest)` calls; the DB stores ONLY
explicit overrides and admin-created entries (the repo's code-owned-defaults rule —
never persist a value equal to the code default; revert = delete the override).
Admin-created *types* are `records_types` rows with `is_custom`; admin-created
*fields* are `records_fields` rows WITH `kind` set. Both surface through the
readers' orphan path — `includeOrphans` in
[server/utils/definition-settings.ts](server/utils/definition-settings.ts) is
**correctness, not admin sugar** (unlike core's apps-catalog precedent). Custom types
get a synthesized intrinsic `name` field (`RECORDS_INTRINSIC_NAME_FIELD`) — label
overridable, never deletable — and the default Open / Done status. Admin field kinds
(`RECORDS_ADMIN_FIELD_KINDS` in [server/utils/schema-admin.ts](server/utils/schema-admin.ts))
exclude `user_select` (code-owned assignment semantics); `connection` is allowed but
forward-only, since reverse keys pair two code manifests.

**assigned_to is multi-user**, stored in `records_user_refs` (composite PK
record/field/user) — never a column. Any future user-reference field reuses that table;
"assigned to me" is an indexed EXISTS.

**Only fields that hand a record to someone grant access.** A `user_select` field
lets the people it names see the record only when its def says `grantsAccess`
(task's assignee, contacts' assigned to); every other people field (an item's
People) only records who's involved. The rule exists so a member's private cards
never reach someone because they were mentioned on them. `visibilityPredicate`
restricts the user-refs leg to `recordsAccessGrantingKeys`. Admin-created fields
can't be people fields, so the flag is code-only.

**Assigning someone who can't see the record asks first.** Writes a person makes
pass `sharing: 'ask'` to `applyFieldPatch` (record routes, MCP, views drags and
card creation); a write that newly names someone in a granting field who can't
see the record by any other path (view_all, creator, share, a visibility source)
is refused with a 409 (`records.share_confirmation`, naming them) until resent
`confirmed`. The check runs after the request's other writes — a card created on
a view its assignee can already open doesn't ask. Another user's view_all is
answered by building their tenant context (`memberContext` in
[server/utils/share-confirmation.ts](server/utils/share-confirmation.ts)). System
writes (producer layers, inbound mail) omit `sharing` and never ask.

**Attachments: their own table, objects deleted by a trash queue.** Files on an
`attachments` field are `records_attachments` rows (bytes in private object
storage under `records/`). They arrive one upload at a time through the
attachments route; a field patch can only reorder or remove them, so a client
can never point a field at someone else's object. An AFTER DELETE trigger copies
each removed row's storage key into `records_attachment_trash` (no org data, no
RLS), which catches every path — a removed file, a deleted record, a deleted
view's files — and a Nitro plugin sweeps the queue every ten minutes. Hydrated
links are signed from the start of a six-hour window so they stay identical
between polls (core's `generateSignedUrl` takes the `requestDate`).

**Virtual fields in the list engine.** `RecordsListOpts.virtualFields` lets a layer
that keeps per-record values outside the kernel (a view's own fields) have them
filtered and sorted like type fields: each supplies a field def and a jsonb value
expression for the current row. Single-value kinds compare as a cast jsonb scalar,
list kinds through jsonb array operators. Field keys starting `vf_` are reserved
for them.

**Permissions & visibility.** Types without a `permissionPrefix` share one generic
`records.entries.*` set (slugs are code-owned; runtime types can't mint them);
contacts use `crm.contacts.*`. `records.schema.manage` gates the builder.
`permFor(typeKey, action)` resolves the slug. Visibility — `view_all` OR creator
(`records_entries.created_by`) OR shared (`records_shares`) OR referenced via a user
field OR a registered visibility source — is compiled into every list/detail query in
[server/utils/list-records.ts](server/utils/list-records.ts). The type's `app`
(default `records`) gates its records the way a route's `appId` would
(`requireRecordType`).

**Three history streams, deliberately separate.** `records_activity` = the display
timeline (full old/new jsonb, no truncation — D.T's 250-char lesson; `actor_label` and
`note` support system/magic-link actors and non-field events; cascades with the
record). crm's `crm_consent_events` = compliance proof (channel-keyed, survives record
deletion). Core's `activity_logs` = host ops log; the kernel never writes it.
Comments (`records_comments`, nullable `author_id` + `author_label`) are their own
stream, merged with activity client-side in the Timeline component.

**The schema builder lives in the org settings shell (`/@<slug>/settings/records`),
not the host admin shell, in multi mode.** Core's `/admin` is operator-gated and its
sections endpoint filters out anything with a `requiredPermission`; schema
customization is org-scoped data needing org context. Single mode has no org settings
shell, so there it sits at `/admin/records`. The page bodies are shared components
(`RecordsSettings{Catalog,Type,Permissions}Page`); `useRecordsSettingsPath()` builds
links into whichever shell is active. The records app is registered with
`launcher: false`: members don't browse raw records (Views is their surface), so it
has no launcher tile or rail entry, but its record pages stay reachable by link.

## Table inventory (11)

`records_entries`, `records_field_entries` (tags/multi_select/link rows,
`normalized_value` for dedupe + reverse lookup), `records_user_refs`,
`records_connections` (from/to + field_key, reverse reads resolved via manifests'
`reverseKey`), `records_attachments` (files, see above), `records_shares`,
`records_activity`, `records_comments`, `records_types`, `records_fields`, and
`records_attachment_trash` (unscoped queue of storage keys to delete).

Migration rules: the tables were created as `crm_*` by `crm_001`–`crm_012` (kept
under their original names here) and renamed by `records_001`; a regular migration
that touches them must sort after `records_001`, so it is a `records_NNN` file, never
`crm_NNN`. **No `org_id` in regular migrations** (T-files run last and never run in
single mode). CHECK constraints only on code-owned-forever vocabularies (share level)
— never on record_type/status/field_key. RLS does not scope unique constraints, so the
global uniques on `records_types`, `records_fields` and the record/user link must be
rebuilt org-leading in multi mode (crm's `crm_T002`/`T003`, or `records_T001` on hosts
without crm).

## Layer structure

```
app/utils/records-manifest.ts    ← #records alias: kinds, manifest types, storageOf, client registries
app/utils/manifests/             ← item and task manifests
app/utils/permissions.ts         ← slugs + meta + default grants + #permissions augmentation
app/utils/field-kinds.ts         ← client kind dispatcher (renderer component + formatter + filter ops)
app/composables/useRecords*.ts   ← types, list, record, users, shares, timeline, schema-admin,
                                   permissions-admin, sidebar, org-key (cache key for org-scoped state)
app/components/records/          ← UI (auto-named Records*); fields/ = one editor per kind; settings/ = builder
app/pages/records/               ← index, [type]/index, [type]/[id], settings/…
client/                          ← #records/client: field settings, formatters, filters
server/utils/                    ← kernel: records-registry, definition-settings, record-storage
                                   (hydrateRecords/applyFieldPatch), list-records, closing, comments,
                                   activity, shares, schema-admin, records-perms, type-permissions,
                                   role-grants-admin, user-grants, normalize, attachments,
                                   share-confirmation
server/exports/index.ts          ← #records/server barrel — lives OUTSIDE server/utils so nitro's
                                   auto-import scan doesn't double-register its re-exports
server/routes/api/records/       ← entries/[type]/…, schema/…, comments/…, users
server/plugins/register-records.ts ← boot registrations (perms, grants, app tile, nav, item, task)
server/plugins/records-attachment-sweep.ts ← deletes queued attachment objects from storage
mcp/                             ← records_* data and schema tools
migrations/  tests/  README.md
```

## Hard-won gotchas (do not relearn these)

1. **postgres-js double-encodes pre-stringified JSONB params.** Binding
   `JSON.stringify(x)` with a bare `::jsonb` cast stores a jsonb *string scalar* and
   `{} || scalar` silently degrades the doc to an array. Always bind through
   **`::text::jsonb`**. (Typecheck/lint/boot all miss it.)
2. **reka-ui throws on `''` select-item values** — empty string is its reserved
   clear-selection sentinel, and the throw happens in `ComboboxItem` setup, wrecking
   the whole popup subtree with cascading null-unmount errors. Use a sentinel value
   (`__none__` pattern in FieldEditor) or `null` (allowed — KeySelectField's clear item).
3. **Everything takes the tenant `tx`.** The org GUC (and therefore
   `current_org_id()`, the DEFAULT for every org_id) exists only inside
   `defineTenantHandler`/`withOrgPermission` transactions. Webhook-ish paths must
   resolve the org first (`runInOrgTransaction`). Kernel functions never import `db`.
4. **`updated_at` has no trigger** — kernel write paths bump it; direct SQL won't.
5. **No cross-request caching of merged definitions** — a cached org-A read served to
   org-B is an RLS bypass by memory. Per-event memo only (the evaluator's per-
   `TenantContext` WeakMap).
6. **Client-side slug checks can't answer per-type questions.** Core's
   `usePermissions()` store carries the caller's effective slugs, but a
   per-type roleGrants row overrides slugs in either direction — so the UI
   gates on server-evaluated flags only (`capabilities` on the record detail,
   `canRead`/`canCreate` on the types GET), never on `hasPermission('records.…')`.
7. **eslint's base path is `dev/`** — layer files sit outside `bun run lint`; match
   style by hand or lint with a wrapper config. `vue/multi-word-component-names` hits
   on `Sidebar.vue` are a known false positive of wrapper configs.
8. **Org switching is SPA navigation — client caches survive it.** Every
   `useState`/module cache of org-scoped data must be keyed by the active org slug
   (`useRecordsOrgKey()`); an unkeyed cache serves org A's data inside org B (stale user
   directory = share picker offering non-members → 400 "Unknown user", assigned
   avatars rendering raw ids). Same-type org switches also reuse the page component
   (one aliased route record, only the `orgSlug` param changes), so per-org fetch
   watches must include the org key, not just `route.params.type`.

## Per-type permissions

Fixes two D.T limitations — read-implies-update and no role-plus-extras — plus
the custom-type granularity gap ("volunteers see trainings but not donations").

**Evaluator** ([server/utils/type-permissions.ts](server/utils/type-permissions.ts),
exported via `#records/server`). `resolveTypePermission(tx, ctx, typeKey, action)`
is the single answer to "may this caller perform \<action\> on \<typeKey\>?".
Decision order: (1) `admin` role → true; (2) direct user grants containing
`permFor(typeKey, action)` → true — personal grants are slug-level and
additive, a role-keyed row can never subtract them; (3) OR over the caller's
roles with **override-with-fallback** semantics: a present
`roleGrants[role][action]` entry IS that role's answer in either direction, an
absent entry falls back to the role's OWN slug set; (4) team rows
(`teamGrants[groupId][action]`) for any team the caller is on → true — teams only
add. (Ceiling/AND semantics were rejected: a matrix checkbox that silently does
nothing without the matching slug is the D.T two-places-to-look trap.)
`resolveTypeCapabilities` answers all six actions in one pass;
`requireTypePermission` / `requireRecordUpdate` are the route gates;
`canUpdateRecord` additionally accepts an edit-level share or a visibility source's
`editPredicate`.

**Storage.** Per-type role and team grants ride on the type's `records_types` row
under `config.roleGrants` / `config.teamGrants` (explicit entries only — org data,
never code defaults), written full-replacement with the usual minimal-row rules.
Direct grants live in core's `user_permission_grants` (user-global in single mode,
org-scoped by RLS in multi; no denies exist anywhere), via
`#core/server/utils/permission-grants`. Share levels: `level` (`view` | `edit`) on
`records_shares` — `edit` grants record-scoped update to a user without the type-wide
slug; delete has no share-level equivalent.

**Capability flags.** The record detail returns `capabilities { canEdit,
canShare, canDelete }` (canEdit = `canUpdateRecord`); the types GET returns
`canRead`/`canCreate` per type. UI gates on these server-evaluated flags, not
client-side slug checks (gotcha 6).

**Admin surface: `/@<slug>/settings/records/permissions`** (`/admin/records/permissions` in single mode; gated `records.schema.manage`).
A roles × actions matrix per record type — tri-state cells where Inherit
renders the role's slug fallback muted and Allow/Deny write explicit rows;
the admin row is locked always-allow — backed by GET/PUT
`/api/records/schema/types/:type/role-grants`. The GET's `effective` map is computed
per role so the matrix is honest about what each cell resolves to. Plus per-user
extra grants (GET/POST `/api/records/schema/user-grants`, DELETE
`.../user-grants/:userId/:permission`; orphan slugs flagged and revocable) fed by the
registered catalog (GET `/api/records/schema/permissions`). The role list = core's
static roles (host + app-static) + `custom_roles` rows, assembled server-side in
[server/utils/role-grants-admin.ts](server/utils/role-grants-admin.ts).

Traps specific to this system:

- `config.roleGrants` / `config.teamGrants` writes are jsonb — **`::text::jsonb`**
  binding (gotcha 1) applies to every raw-SQL touch of the column.
- The evaluator memoizes per `TenantContext` (WeakMap) — a request that writes
  grants and then re-evaluates with the same ctx reads **stale grants**.
  The write routes never re-run the evaluator; they rebuild their response via
  `buildRoleGrantsView`, which reads fresh state.
- Per-role fallback answers need `getRolePermissions(tx, [role], orgId)` for
  that single role — `ctx.perms` is the caller's pre-unioned effective set and
  cannot answer per-role questions.
- The evaluator ignores token scopes. Routes reached by OAuth clients narrow by scope
  themselves (`records.read` / `records.write`) before calling it.

## Deferred (planned, not built)

Dedup detection/merge UI · mentions/reactions · location field kind ·
OAuth grants union (core's `getUserPermissions` — what the oauth layer
intersects scopes with — unions role perms only, so direct
`user_permission_grants` never reach token power) · org-role OAuth gap
(same function reads global `users.roles`, not per-org membership roles, so
org-granted roles don't shape tokens either) · single-mode custom-role
creation surface (only tenancy ships create/edit endpoints —
`/api/o/:slug/roles`) · import/export · soft delete/trash · reverse keys on
admin-created connections · fresh-DB single-mode e2e.
