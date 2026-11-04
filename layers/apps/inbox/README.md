# @nuxtinator/inbox

A two-way shared email inbox built on the CRM layer: contacts email your domain,
the team triages and replies from `/inbox`, and every address automatically becomes
a CRM channel identity — with ownership verification, bounce suppression, and
consent tracking flowing into the CRM for free.

Requires `@nuxtinator/crm` (and core/tenancy as usual). Mail transport is Mailgun
in production and Mailpit (`localhost:1025`, UI on `:8025`) in development.

## Features

- **Inbound**: signed Mailgun webhook; per-conversation reply addresses
  (`contact+<token>@your-domain`); threading by token and References; sender
  classification (mail that reaches a thread from a sender who doesn't own it is
  **held for review**, never trusted); spam blocklist; vacation/auto-responder
  handling; attachments + raw MIME archived to S3.
- **Outbound**: queued replies delivered by a background sweep with quoted
  history, correct threading headers, and at-most-once send semantics; automatic
  acknowledgment for new conversations (per-org toggle).
- **CRM integration**: DKIM/DMARC-authenticated inbound marks the channel
  *verified*; hard bounces/complaints write CRM suppressions (blocking future
  sends); Mailgun unsubscribes flip the channel's marketing consent; contact
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
| `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `MAILGUN_HOST` | prod | Sending (shared with the email-mailgun layer) |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | prod | Webhook HMAC verification — the **HTTP webhook signing key** (Settings → API Keys), NOT the sending key |
| `INBOX_DOMAIN` | yes | Domain inbound mail is addressed to (single-tenant default; per-org override via settings) |
| `INBOX_CONTACT_ADDRESS` | yes | Shared From identity + base of `contact+<token>` reply addresses |
| `INBOX_SLUG_ADDRESSES` | no | `true` in multi-tenant deploys where orgs share `INBOX_DOMAIN`: an org on it gets `<org slug>@INBOX_DOMAIN` as its contact address (derived, never stored) and new mail to it routes by slug. Personal aliases are off on the shared domain; an operator can still give an org its own domain |
| `INBOX_SEND_SWEEP_SECONDS` | no | Send sweep cadence (default 20) |
| `INBOX_AUTO_CLOSE_CRON` | no | UTC cron for the nightly auto-close sweep (default `0 4 * * *`); the per-org quiet threshold is an inbox setting |
| `NUXT_PUBLIC_SITE_URL` | yes | Canonical origin for links in mail (the auto-ack's confirmation link is dropped when unset) |

Multi-tenant: each org claims its own inbound (sub)domain via the settings store
(namespace `inbox`, keys `inbound_domain` / `contact_address` / `auto_ack_enabled` /
`auto_close_days`).
Two orgs must never claim the same domain — such mail is unroutable and dropped,
except the shared domain under `INBOX_SLUG_ADDRESSES`, which routes by slug.

## Mailgun setup (per environment)

1. **Add + verify the domain** in Mailgun (bare domain to match
   `INBOX_DOMAIN`), region US or EU (match `MAILGUN_HOST`).
2. **DNS**: MX `mxa.mailgun.org` + `mxb.mailgun.org` (priority 10) on the inbox
   domain — this reroutes ALL mail for the domain, confirm nothing else uses its
   MX; SPF `v=spf1 include:mailgun.org ~all`; the DKIM TXT record from the
   dashboard (required for inbound *authentication* — sender verification and
   courtesy mail gate on it); DMARC `v=DMARC1; p=none`.
3. **Inbound route**: Receiving → Create Route → Match Recipient `.*@your-domain`
   (catch-all) → Forward → `https://your-app/api/inbox/webhooks/mailgun/inbound`.
4. **Event webhook**: Sending → Webhooks → add
   `https://your-app/api/inbox/webhooks/mailgun/events` for `delivered`,
   `permanent_failure`, `complained`, and `unsubscribed`.
5. Set the env vars (webhook **signing** key ≠ sending API key) and enable the
   Inbox app for the org(s) that use it.

An unsigned `curl -X POST https://your-app/api/inbox/webhooks/mailgun/inbound`
should return 4xx (never 404) — that confirms the route is reachable.

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

## Local development

No Mailgun needed: outbound mail lands in Mailpit (http://localhost:8025). To
exercise inbound, POST a signed multipart fixture — see the builder in
[tests/helpers/index.ts](tests/helpers/index.ts) and the notes in [dev.md](dev.md).
Tests: `bun run test -- --project inbox` from `dev/`.
