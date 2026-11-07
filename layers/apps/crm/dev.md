# CRM layer — maintainer notes

Working doc for sessions building out `@nuxtinator/crm`. [README.md](README.md) is the
consumer-facing overview; this file records the *decisions*, their rationale, and the
traps. The record kernel crm builds on — storage, definitions, the list engine,
per-type permissions, the schema builder, and the gotchas that apply to every record
type — is documented in [../../records/dev.md](../../records/dev.md). The original
discovery/plan lives in the repo's `context/crm-layer-plan.md` and
`context/crm-schema.svg`.

## What this layer is

The **contacts** record type on top of `@nuxtinator/records`, plus communication
channels, consent, suppression and account links. It is the base other layers build
on (email inbox, email marketing, contact-us forms, a future Disciple.Tools rebuild).
Works in single-tenant mode and org-scoped multi-tenant mode with no mode-conditional
code — everything rides the tenant transaction.

## Decision log (what we chose and why)

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
- `canSend(tx, { channelType, normalizedValue, purpose })` is the single gate sender
  layers call: opt_in AND not suppressed.
- Verification is dormant plumbing: hashed token columns on `crm_channels`, functions
  exist, no routes/UI, `verified` is never client-writable. Activate with the first
  sender/inbox layer.

**How crm plugs into the kernel.** [server/plugins/register-crm.ts](server/plugins/register-crm.ts)
registers the contacts manifest (`permissionPrefix: 'crm.contacts'`, `app: 'crm'`,
`boardsGrantVisibility: false`), the `channels` storage driver
([server/utils/channel-storage.ts](server/utils/channel-storage.ts)), a closing hook
that revokes consent ([server/utils/consent-on-close.ts](server/utils/consent-on-close.ts)),
and a patch guard for account-owned fields ([server/utils/account-link.ts](server/utils/account-link.ts)).
[app/plugins/register-crm-ui.ts](app/plugins/register-crm-ui.ts) gives contacts their
home at `/crm/contacts` and adds the channel field widget, the channel-type kind
settings and the Channel types settings section. Admin-created channel fields work
end-to-end: `communication_channel` is an admin field kind with a channelType picker.

**Contacts are never shared through a board.** The contacts manifest opts out of
board-granted visibility, so a shared view never widens who may see a contact.

## Table inventory (6)

`crm_channel_types`, `crm_channels`, `crm_contact_channels`,
`crm_channel_consents`, `crm_consent_events`, `crm_channel_suppressions`. Records
themselves live in the kernel's `records_*` tables.

Migration rules: filenames `crm_NNN_*` / tenancy retrofits `crm_TNNN_*` (globally
unique across all layers). `crm_NNN` sorts before the kernel's `records_001` rename,
so a crm migration may touch only crm's own tables; a change to a kernel table goes
in the records layer. `crm_T001`–`T003` were written against the kernel's old
`crm_record*` names and look up whichever name is in place. **No `org_id` in regular
migrations**; CHECK constraints only on code-owned-forever vocabularies (consent
status/event, suppression reason, channel value_format) — never on purpose;
**T002 is not optional** — RLS does not scope unique constraints, so the global
uniques must be rebuilt org-leading or two orgs can't hold the same email.

## Layer structure

```
app/utils/crm.ts                 ← #crm alias: shared crm types
app/utils/manifests/contacts.ts  ← the contacts manifest
app/utils/permissions.ts         ← crm.access + crm.contacts.* slugs, meta, default grants
app/composables/useCrm*.ts       ← channels, channel types
app/components/crm/              ← channel widgets, consent panel, channel-type settings
app/pages/crm/                   ← index (redirect), contacts/index, contacts/[id]
app/plugins/register-crm-ui.ts   ← client registrations into #records
server/utils/                    ← channels, channel-storage, channel-settings, channel-types-admin,
                                   consent, consent-on-close, suppression, account-link, crm-registry
server/exports/index.ts          ← #crm/server barrel (outside server/utils, as in records)
server/routes/api/crm/           ← records/[type]/[id]/channels|consent, schema/channel-types
server/plugins/register-crm.ts   ← boot registrations (perms, grants, app tile, nav, contacts type,
                                   kernel hooks, channel types, consent purposes)
mcp/                             ← crm_get_addresses, crm_link_channel, crm_unlink_channel, crm_set_consent
migrations/  seeds/  tests/  README.md
```

Extension points for consumer layers: `registerCrmChannelType`,
`registerCrmConsentPurpose`, and the `#crm/server` services
(`claimChannel`/`findChannel`, `canSend`, `grantConsent`/`revokeConsent`, `suppress`).
Record-level services (`applyFieldPatch`, `listRecords`, `getRecord`, comments,
activity, shares) come from `#records/server`.

## Hard-won gotchas (do not relearn these)

The kernel's gotchas ([../../records/dev.md](../../records/dev.md#hard-won-gotchas-do-not-relearn-these))
all apply here too. On top of those:

1. **Never name ON CONFLICT targets** on channels/suppressions — the unique index
   differs between single mode and multi mode (T002), so only a bare
   `ON CONFLICT DO NOTHING` is portable.
2. Editing a channel **value** is replace-not-mutate: claim the new identity and
   relink — the old row may be shared with other contacts and carries its own history.
3. Channel identity rows deliberately survive record deletion (registry semantics).
   Deleting test data cleanly means also removing orphaned channel rows via SQL.

## Dev workflow

Run from `dev/`. `bun run seed` plants demo users (`admin@example.com` /
`password123`, org `acme`) and 8 demo contacts (incl. a shared address:
`bennetts@example.com` on both Bennetts). Tests: `bun run test -- --project crm`.
API poking: cookie login + `X-Active-Org: acme` header. Typecheck/lint from `dev/` as
usual. E2E-style verification via playwright-core against `bun dev` has caught what
static gates missed — prefer it for UI bugs. Release: `/release-layer crm <version>`.

## Deferred (planned, not built)

Verification UX (issue/consume routes + email) · suppression producers (bounce
webhook: claim channel → suppress by FK) + admin suppression list · open/click
tracking · `groups` record type (thin manifest reusing the kernel) · D.T data
migration.
