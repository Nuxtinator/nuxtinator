# @nuxtinator/inbox

A two-way shared email inbox built on the CRM layer: contacts email your domain,
the team triages and replies from `/inbox`, and every address automatically becomes
a CRM channel identity — with ownership verification, bounce suppression, and
consent tracking flowing into the CRM for free.

Requires `@nuxtinator/crm` and `@nuxtinator/mail` (and core/tenancy as usual). Mail
goes through core's mail kernel on the `inbox` stream: whatever provider a host admin
set up under **Admin → Email** in production, Mailpit (`localhost:1025`, UI on
`:8025`) in development.

## Features

- **Inbound**: the mail kernel's provider webhooks hand each message to the
  inbox's catch-all inbound handler; per-conversation reply addresses
  (`contact+<token>@your-domain`); threading by token and References; sender
  classification (mail that reaches a thread from a sender who doesn't own it is
  **held for review**, never trusted); spam blocklist; vacation/auto-responder
  handling; attachments + raw MIME archived to S3.
- **Outbound**: queued replies delivered by a background sweep with quoted
  history, correct threading headers, and at-most-once send semantics; automatic
  acknowledgment for new conversations (per-org toggle).
- **CRM integration**: DKIM/DMARC-authenticated inbound marks the channel
  *verified*; hard bounces/complaints land on the mail kernel's suppression list
  (blocking future sends); provider unsubscribes flip the channel's marketing
  consent (CRM's event handler); contact
  chips + create-contact-from-conversation on every thread.
- **Triage UI**: 3-pane inbox (scope folders / list / thread) with search,
  status strip, assignment, review queue, bulk actions (close / assign / tag a
  checked set), and a rich-text composer whose To line shows whether the reply
  address is verified or suppressed (sending is blocked while a suppression
  stands).
- **Housekeeping**: a nightly sweep closes pending conversations quiet for
  longer than the org's threshold (default 14 days, 0 disables; held threads
  never expire); contact-form senders get an address-confirmation link in the
  auto-ack, redeemed at `/api/inbox/verify/:token`.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `INBOX_SLUG_ADDRESSES` | no | `true` in multi-tenant deploys: an org with no receiving domain of its own uses the host's inbox domain, gets `<org slug>@<that domain>` as its contact address (derived, never stored), and new mail to it routes by slug. Contact local parts and personal aliases don't apply there. Read at runtime |
| `INBOX_SEND_SWEEP_SECONDS` | no | Send sweep cadence (default 20) |
| `INBOX_AUTO_CLOSE_CRON` | no | UTC cron for the nightly auto-close sweep (default `0 4 * * *`); the per-org quiet threshold is an inbox setting |
| `NUXT_PUBLIC_SITE_URL` | yes | Canonical origin for links in mail (the auto-ack's confirmation link is dropped when unset) |

Provider keys and domains are the mail kernel's (`MAIL_*`, or `MAILGUN_API_KEY` /
`MAILGUN_DOMAIN` for the env account); see the mail layer's docs.

## Mail domains

The inbox stream needs a domain that can **receive** (replies come back to it). For
each org the kernel resolves the inbox stream's domain: the org's own domain when it
has one that can send and receive, else the host's (its inbox route, its `*` route,
then the env domain). The org's shared contact address is `<contact_local>@<that
domain>` (`contact_local` is an inbox setting, default `contact`), or `<slug>@` the
host's domain under `INBOX_SLUG_ADDRESSES`. Replies use `<contact address
local>+<token>@<domain>` as Reply-To.

Until some domain can receive, the inbox shows "No domain can receive mail yet" and
holds replies in the queue (nothing is lost); they go out once a domain qualifies.

Setting one up (host admin, **Admin → Email**):

1. Add the provider account, then the inbox domain on it for sending **and
   receiving** (manual setup if the key can't manage domains). Point the domain's MX
   at the provider — this reroutes ALL mail for the domain, so confirm nothing else
   uses its MX. Authentication DNS (SPF/DKIM/DMARC) matters for inbound too: sender
   verification and courtesy mail gate on authenticated mail.
2. Forward inbound mail as raw MIME to the account's **inbound** webhook URL and
   subscribe the **events** URL (both shown on the account); the receiving probe
   turns green when the route works.
3. Assign the inbox stream to the domain (Streams tab) and enable the Inbox app for
   the org(s) that use it.

Inbound routing: reply-token mail goes to the token's conversation; other mail on an
org's own domain goes to that org; on a host domain, to the org named by the slug
under slug addresses, to the one inbox in single-tenant mode, and is dropped
otherwise. Per-org settings live in the settings store (namespace `inbox`, keys
`contact_local` / `brand_from_name` / `auto_ack_enabled` / `auto_close_days` / …).

## Permissions

- `inbox.access` — open the app, read, triage (status/assign/review flags)
- `inbox.read` — read conversations from an AI client over MCP (no triage)
- `inbox.send` — compose and reply, spam blocklist
- `inbox.settings.manage` — the settings page: inbox configuration and
  teammates' sending aliases

Default grants: `admin` everything, `member` nothing (grant via role or per-user
grants). The `inbox_agent` role has `inbox.access`, `inbox.read` and `inbox.send`.

## MCP tools

When the host also loads the MCP layer, the inbox registers tools for AI
clients (all with `appId: 'inbox'` and an optional `org` slug):

| Tool | Scope | Effect |
|---|---|---|
| `inbox_list_conversations` | `inbox.read` | read |
| `inbox_read_conversation` | `inbox.read` | read |
| `inbox_list_for_record` | `inbox.read` | read |
| `inbox_list_assignees` | `inbox.read` | read |
| `inbox_get_drafting_background` | `inbox.read` | read |
| `inbox_save_draft` | `inbox.send` | write (AI draft, never sent) |
| `inbox_add_comment` | `inbox.access` | write |
| `inbox_update_conversation` | `inbox.access` | write (status, assignee, tags; never spam) |
| `inbox_send_reply` | `inbox.send` | destructive (sends mail outside the org) |

Text written by outside senders is wrapped in `<untrusted_email nonce="…">`
markers with a fresh nonce per response. Held messages return no body unless
the call sets `includeHeld`. Writes show on the conversation timeline under the
user, labelled "via <client name>". Replies to a suppressed address, or sent
while the inbox has no sending address, are refused with 409 here and in the
composer route alike.

## Adding actions to a conversation

A host or another layer can add items to a conversation header's "More actions"
menu without copying the inbox's components. Register them from a Nuxt app
plugin with `registerInboxThreadAction` from the `#inbox` alias:

```ts
// app/plugins/inbox-actions.ts
import { registerInboxThreadAction } from '#inbox'

export default defineNuxtPlugin(() => {
  registerInboxThreadAction({
    id: 'ask-for-help',          // stable; registering the same id again replaces it
    label: 'Ask for help',
    icon: 'i-lucide-life-buoy',
    order: 100,                  // ascending (default 100), after the built-in items
    visible: ctx => ctx.conversation.status !== 'closed',  // optional; shown by default
    onSelect: async (ctx) => {
      await $fetch(`/api/my-app/help-requests`, { method: 'POST', body: { conversationId: ctx.conversation.id } })
      await ctx.refresh()
    }
  })
})
```

`ctx` holds the `conversation` (id, subject, status, assignee, review flag,
tags, …), the current user as `me` (`InboxMe`, `null` while loading), and
`refresh()`, which reloads the thread and its "Notes & activity" timeline. An
event the action's route records with `inboxLogConversationEvent` from
`#inbox/server` shows on the timeline after `refresh()`.

The inbox checks no permission for a registered action: the registering layer
decides in `visible` and enforces on its own route. To show a dialog, open it
from `onSelect` with Nuxt UI's `useOverlay`. With nothing registered the menu
holds only the built-in items.

`#inbox` is for app code; server code imports from `#inbox/server`.

## Local development

No provider needed: outbound mail lands in Mailpit (http://localhost:8025). To
exercise inbound, run with `MAIL_FAKE_PROVIDER=1` and POST raw MIME to a fake-provider
account's inbound URL — see the fixture builder in
[tests/helpers/index.ts](tests/helpers/index.ts) and the notes in [dev.md](dev.md).
Tests: `bun run test -- --project inbox` from `dev/`.
