# CRM layer — maintainer notes

Working doc for sessions building out `@nuxtinator/crm`. [README.md](README.md) is the
consumer-facing overview; this file records the *decisions*, their rationale, and the
traps. The original discovery/plan lives in the repo's `context/crm-layer-plan.md` and
`context/crm-schema.svg`.

## What this layer is

A generic **record kernel** + the **contacts** record type + a default CRM UI, in one
layer. It is the base other layers will build on (email inbox, email marketing,
contact-us forms, a future Disciple.Tools rebuild). Works in single-tenant mode and
org-scoped multi-tenant mode with no mode-conditional code — everything rides the
tenant transaction.

## Decision log (what we chose and why)

**Storage: one `crm_records` table, promoted hot columns + JSONB — not CTI, not EAV, not runtime DDL.**
Promoted real columns (`name`, `status`, `record_type`, timestamps) carry the fields
every list query filters/sorts on; all other single-value scalars live in the `data`
JSONB doc; multi-value kinds get row-per-value satellites. Full EAV (WordPress
postmeta, what D.T suffers under) pays a join per field on the hottest queries; pure
JSONB starves the planner on hot fields. Runtime DDL (Twenty-style) was rejected
because org-created types would need per-org DDL under shared-schema RLS. The storage
router keeps a per-type extension table (class-table inheritance) reachable later
without rearchitecting — a manifest could map its fields to real columns.

**One field-kind registry drives everything.** `storageOf()` + the kind vocabulary in
[app/utils/crm-manifest.ts](app/utils/crm-manifest.ts) decide storage, validation,
rendering (`app/utils/field-kinds.ts` dispatcher), and filter compilation. D.T's
plague of parallel hand-maintained type lists is the anti-pattern this exists to avoid.
Adding a kind touches the vocabulary + router + one renderer + one validator — nothing else.

**Channels are entities, shared by contacts.** `crm_channels` holds one row per
distinct address per org (unique on `channel_type + normalized_value`, org-scoped by
T002); `crm_contact_channels` links records to them — one address CAN belong to
multiple contacts (family email), so consent expressed once applies to everyone
holding it. Rows may exist with no links at all (address registry: bounces and
inbound senders get history before they become contacts). Per-contact stuff (label,
`is_primary`, which field) lives on the link, never the channel.

**Consent ≠ suppression, and both live on the channel.**
- `crm_channel_consents`: current expressed intent, one row per channel × purpose
  (join rows with timestamps + capture meta — never array columns). No row = unknown.
- `crm_consent_events`: append-only compliance proof — carries the literal value
  snapshot + a sha256 fingerprint so history survives channel erasure, plus
  ip/user-agent/actor/source capture.
- `crm_channel_suppressions`: deliverability (hard_bounce | complaint | manual). An
  unsubscribe flips consent and never writes here; a bounce writes here and never
  touches consent — transactional mail must keep flowing past an unsubscribe
  (Klaviyo lesson). One active suppression per channel (partial unique
  `WHERE cleared_at IS NULL`); only `manual` can be cleared.
- `canSend(tx, { channelType, normalizedValue, purpose })` in the kernel is the single
  gate future sender layers call: opt_in AND not suppressed.
- Verification is dormant plumbing: hashed token columns on `crm_channels`, functions
  exist, no routes/UI, `verified` is never client-writable. Activate with the first
  sender/inbox layer.

**Definitions: code manifests ⊳ org-scoped DB overrides (defineSettings).**
Code-shipped types are `registerCrmRecordType(manifest)` calls; the DB stores ONLY
explicit overrides and admin-created entries (the repo's code-owned-defaults rule —
never persist a value equal to the code default; revert = delete the override).
Admin-created *types* are `crm_record_types` rows with `is_custom`; admin-created
*fields* are `crm_record_fields` rows WITH `kind` set. Both surface through the
readers' orphan path — `includeOrphans` in
[server/utils/definition-settings.ts](server/utils/definition-settings.ts) is
**correctness, not admin sugar** (unlike core's apps-catalog precedent). Custom types
get a synthesized intrinsic `name` field (`CRM_INTRINSIC_NAME_FIELD`) — label
overridable, never deletable. Admin field kinds exclude `user_select` and
`connection` (v1) but include `communication_channel` with a channelType picker, so
admin-created channel types are usable end-to-end.

**assigned_to is multi-user**, stored in `crm_record_user_refs` (composite PK
record/field/user) — never a column. Any future user-reference field reuses that table;
"assigned to me" is an indexed EXISTS.

**Permissions & visibility.** Granular slugs for contacts
(`crm.contacts.{read,create,update,delete,share,view_all}`), one generic
`crm.records.*` set shared by ALL admin-created types (slugs are code-owned; runtime
types can't mint them), `crm.schema.manage` for the builder. `permFor(typeKey, action)`
resolves. Visibility — `view_all` OR creator (`crm_records.created_by`) OR shared
(`crm_record_shares`) OR referenced via a user field — is compiled into every
list/detail query in
[server/utils/list-records.ts](server/utils/list-records.ts); D.T-style record-level
access arrives later through that same hook without repainting queries.

**Three history streams, deliberately separate.** `crm_record_activity` = the display
timeline (full old/new jsonb, no truncation — D.T's 250-char lesson; `actor_label` and
`note` support system/magic-link actors and non-field events; cascades with the
record). `crm_consent_events` = compliance proof (channel-keyed, survives record
deletion). Core's `activity_logs` = host ops log; the kernel never writes it.
Comments (`crm_record_comments`, nullable `author_id` + `author_label`) are their own
stream, merged with activity client-side in the Timeline component.

**The schema builder lives at `/crm/settings`, not the host admin shell.** Core's
`/admin` is operator-gated and its sections endpoint filters out anything with a
`requiredPermission`; schema customization is org-scoped data needing org context.
Don't move it back.

**v1 simplifications:** hard delete (no trash), no dedup/merge UI, no mentions, no
location kind, no import/export, no saved views.

## Table inventory (15)

Kernel: `crm_records`, `crm_record_field_entries` (tags/multi_select/link rows,
`normalized_value` for dedupe + reverse lookup), `crm_record_user_refs`,
`crm_record_connections` (from/to + field_key, reverse reads resolved via manifests'
`reverseKey`), `crm_record_shares`, `crm_record_activity`, `crm_record_comments`,
`crm_record_types`, `crm_record_fields`.
Channels: `crm_channel_types`, `crm_channels`, `crm_contact_channels`,
`crm_channel_consents`, `crm_consent_events`, `crm_channel_suppressions`.

Migration rules: filenames `crm_NNN_*` / tenancy retrofits `crm_TNNN_*` (globally
unique across all layers); **no `org_id` in regular migrations** (T-files run last and
never run in single mode); CHECK constraints only on code-owned-forever vocabularies
(consent status/event, suppression reason, channel value_format) — never on
record_type/status/field_key/purpose; **T002 is not optional** — RLS does not scope
unique constraints, so the global uniques from 004/008 must be rebuilt org-leading or
two orgs can't hold the same email.

## Layer structure

```
app/utils/crm-manifest.ts        ← #crm alias: kinds, manifest types, storageOf, InferRecordShape,
                                   open CrmRecordTypeRegistry (declare module '#crm' to extend)
app/utils/manifests/contacts.ts  ← the contacts manifest
app/utils/permissions.ts         ← slugs + meta + default grants + #permissions augmentation
app/utils/field-kinds.ts         ← client kind dispatcher (renderer component + formatter + filter ops)
app/composables/useCrm*.ts       ← types, records, record, users, channels, shares, timeline, schema-admin,
                                   org-key (cache key for org-scoped client state)
app/components/crm/              ← UI (auto-named Crm*); fields/ = one editor per kind; settings/ = builder
app/pages/crm/                   ← index (redirect), [type]/index, [type]/[id], settings/…
server/utils/                    ← kernel: crm-registry, definition-settings, record-storage
                                   (hydrateRecords/applyFieldPatch), list-records, channels, consent,
                                   suppression, comments, activity, shares, schema-admin, crm-perms,
                                   type-permissions, role-grants-admin, user-grants, normalize
server/exports/index.ts          ← #crm/server barrel — lives OUTSIDE server/utils so nitro's
                                   auto-import scan doesn't double-register its re-exports
server/routes/api/crm/           ← records/[type]/…, schema/…, users; all withOrgPermission + zod
server/plugins/register-crm.ts   ← single owner of ALL boot registrations (perms, grants, app tile,
                                   nav, record type, channel types, consent purposes)
migrations/  seeds/  tests/  README.md
```

Extension points for consumer layers: `registerCrmRecordType` +
`declare module '#crm'`, `registerCrmChannelType`, `registerCrmConsentPurpose`,
`registerCrmFieldFilter('create'|'update', fn)` (the `dt_post_create_fields`
analogue), and the `#crm/server` services (`applyFieldPatch`, `listRecords`,
`getRecord`, `claimChannel`/`findChannel`, `canSend`, `grantConsent`/`revokeConsent`,
`suppress`, comments/activity/shares helpers).

## Hard-won gotchas (do not relearn these)

1. **postgres-js double-encodes pre-stringified JSONB params.** Binding
   `JSON.stringify(x)` with a bare `::jsonb` cast stores a jsonb *string scalar* and
   `{} || scalar` silently degrades the doc to an array. Always bind through
   **`::text::jsonb`**. (Found live in M3; typecheck/lint/boot all missed it.)
2. **reka-ui throws on `''` select-item values** — empty string is its reserved
   clear-selection sentinel, and the throw happens in `ComboboxItem` setup, wrecking
   the whole popup subtree with cascading null-unmount errors. Use a sentinel value
   (`__none__` pattern in FieldEditor) or `null` (allowed — KeySelectField's clear item).
3. **Everything takes the tenant `tx`.** The org GUC (and therefore
   `current_org_id()`, the DEFAULT for every org_id) exists only inside
   `defineTenantHandler`/`withOrgPermission` transactions. Webhook-ish paths must
   resolve the org first (`runInOrgTransaction`). Kernel functions never import `db`.
4. **Never name ON CONFLICT targets** on channels/suppressions — the unique index
   differs between single mode and multi mode (T002), so only a bare
   `ON CONFLICT DO NOTHING` is portable.
5. **No cross-request caching of merged definitions** — a cached org-A read served to
   org-B is an RLS bypass by memory. Per-event memo only, if profiling ever demands it.
6. **`updated_at` has no trigger** — kernel write paths bump it; direct SQL won't.
7. **Client-side slug checks can't answer per-type questions.** Core's
   `usePermissions()` store carries the caller's effective slugs, but a
   per-type roleGrants row overrides slugs in either direction — so CRM UI
   gates on server-evaluated flags only (`capabilities` on the record detail,
   `canRead`/`canCreate` on the types GET, `canManage` from the channel-types
   GET), never on `hasPermission('crm.…')`.
8. **eslint's base path is `dev/`** — layer files sit outside `bun run lint`; match
   style by hand or lint with a wrapper config. `vue/multi-word-component-names` hits
   on `Sidebar.vue` are a known false positive of wrapper configs.
9. Editing a channel **value** is replace-not-mutate: claim the new identity and
   relink — the old row may be shared with other contacts and carries its own history.
10. Channel identity rows deliberately survive record deletion (registry semantics).
    Deleting test data cleanly means also removing orphaned channel rows via SQL.
11. **Org switching is SPA navigation — client caches survive it.** Every
    `useState`/module cache of org-scoped data must be keyed by the active org slug
    (`useCrmOrgKey()`); an unkeyed cache serves org A's data inside org B (stale user
    directory = share picker offering non-members → 400 "Unknown user", assigned
    avatars rendering raw ids). Same-type org switches also reuse the page component
    (one aliased route record, only the `orgSlug` param changes), so per-org fetch
    watches must include the org key, not just `route.params.type`.

## Dev workflow

Run from `dev/`. `bun run seed` plants demo users (`admin@example.com` /
`password123`, org `acme`) and 8 demo contacts (incl. a shared address:
`bennetts@example.com` on both Bennetts). Tests: `bun run test -- --project crm`
(77 tests; other layers' projects currently fail on a stale global-setup path —
pre-existing, not ours). API poking: cookie login + `X-Active-Org: acme` header.
Typecheck/lint from `dev/` as usual. E2E-style verification via playwright-core
against `bun dev` has caught what static gates missed — prefer it for UI bugs.
Release: `/release-layer crm <version>`.

## Permissions v2

Fixes two D.T limitations — read-implies-update and no role-plus-extras — plus
the custom-type granularity gap ("volunteers see trainings but not donations").

**Evaluator** ([server/utils/type-permissions.ts](server/utils/type-permissions.ts),
exported via `#crm/server`). `resolveTypePermission(tx, ctx, typeKey, action)`
is the single answer to "may this caller perform \<action\> on \<typeKey\>?".
Decision order: (1) `admin` role → true; (2) direct user grants containing
`permFor(typeKey, action)` → true — personal grants are slug-level and
additive, a role-keyed row can never subtract them; (3) OR over the caller's
roles with **override-with-fallback** semantics: a present
`roleGrants[role][action]` entry IS that role's answer in either direction, an
absent entry falls back to the role's OWN slug set. (Ceiling/AND semantics
were rejected: a matrix checkbox that silently does nothing without the
matching slug is the D.T two-places-to-look trap.) `resolveTypeCapabilities`
answers all six actions in one pass; `requireTypePermission` /
`requireRecordUpdate` are the route gates; `canUpdateRecord` additionally
accepts an edit-level share. "Why can Bob do X" always has exactly two
possible answers: a personal grant, or one of his roles (row or slug).

**Storage.** Per-type role grants ride on the type's `crm_record_types` row
under `config.roleGrants` (`{ role: { action: boolean } }`, explicit entries
only — org data, never code defaults), written full-replacement by
`updateTypeRoleGrants` with the usual minimal-row rules. Direct grants live in
core's `user_permission_grants` (user-global in single mode, org-scoped by RLS
in multi; no denies exist anywhere), via `#core/server/utils/permission-grants`.
Share levels: `level` (`view` | `edit`) on `crm_record_shares` — `edit` grants
record-scoped update to a user without the type-wide slug; delete has no
share-level equivalent. Effective session perms (role ∪ grants) feed the client
store through `/api/_perms` (single) / `/api/o/:slug/_perms` (multi).

**Capability flags.** The record detail returns `capabilities { canEdit,
canShare, canDelete }` (canEdit = type update answer OR edit share); the types
GET returns `canRead`/`canCreate` per type. UI gates on these server-evaluated
flags, not client-side slug checks (gotcha 7).

**Admin surface: `/crm/settings/permissions`** (gated `crm.schema.manage`).
A roles × actions matrix per record type — tri-state cells where Inherit
renders the role's slug fallback muted and Allow/Deny write explicit rows;
the admin row is locked always-allow — backed by GET/PUT
`/api/crm/schema/types/:type/role-grants`. The GET's `effective` map
(`{ allowed, source: 'row'|'slug'|'admin', fallback }`) is computed per role so
the matrix is honest about what each cell resolves to. Plus per-user extra
`crm.*` grants (GET/POST `/api/crm/schema/user-grants`, DELETE
`.../user-grants/:userId/:permission`; orphan slugs flagged and revocable) fed
by the registered catalog (GET `/api/crm/schema/permissions`). The role list =
core's static roles (host + app-static) + `custom_roles` rows, assembled
server-side in [server/utils/role-grants-admin.ts](server/utils/role-grants-admin.ts)
— no core endpoint needed.

Traps specific to this system:

- `config.roleGrants` writes are jsonb — **`::text::jsonb`** binding (gotcha 1)
  applies to every raw-SQL touch of the column.
- The evaluator memoizes per `TenantContext` (WeakMap) — a request that writes
  roleGrants and then re-evaluates with the same ctx reads **stale grants**.
  The write routes never re-run the evaluator; they rebuild their response via
  `buildRoleGrantsView`, which reads fresh state.
- Per-role fallback answers need `getRolePermissions(tx, [role], orgId)` for
  that single role — `ctx.perms` is the caller's pre-unioned effective set and
  cannot answer per-role questions.

## Deferred (planned, not built)

Dedup detection/merge UI · mentions/reactions · location field kind ·
OAuth grants union (core's `getUserPermissions` — what the oauth layer
intersects scopes with — unions role perms only, so direct
`user_permission_grants` never reach token power) · org-role OAuth gap
(same function reads global `users.roles`, not per-org membership roles, so
org-granted roles don't shape tokens either) · single-mode custom-role
creation surface (the `custom_roles` table works in both modes but only
tenancy ships create/edit endpoints — `/api/o/:slug/roles`; single-mode
deploys have no UI/route to mint one) · verification UX (issue/consume routes +
email) · suppression producers (bounce webhook: claim channel → suppress by FK) +
admin suppression list · open/click tracking · import/export · saved list views ·
soft delete/trash · `groups` record type (thin manifest reusing the kernel) · D.T
data migration · fresh-DB single-mode e2e (dev DB already carries T-migration RLS,
so single-mode create can't be proven there).
