# Inbox layer — implementation plan

Status doc for finishing `@nuxtinator/inbox`. Companion to [dev.md](dev.md) (decision log)
and [README.md](README.md) (consumer setup). This file is the **build backlog**: every feature
and edge case the initial version did not carry, in recommended build order, with the
load-bearing bug/edge-case logic each item must preserve.

## How this was produced

Full subsystem-by-subsystem review of this layer — 16 passes
(conversation API, compose/send, attachments+images, inbound pipeline, delivery/suppressions,
tags, canned responses, knowledge/AI, identities, notifications/activity, spam, main UI, schema,
CRM integration, tests/docs, plus a completeness sweep), each adversarially re-verified against
the actual layer code. Source of truth for the details behind each line here:
`scratchpad/inbox-gaps.json` (raw) and `inbox-gaps-digest.md` (readable) from the scan session.

**Topline:** 64 behaviors already solid; 23 deliberate design choices (do not "fix" back);
~135 gaps totalling ~2.9M tokens of implementation. The two the user flagged as most notable —
**outbound image upload / inline-image pipeline** and **CRM-layer integration** — are Phases 2
and 5 and can be pulled to the front.

## Cross-cutting decisions to make before building

These fork the work; decide them up front.

1. **i18n — DECIDED: not now.** The go-saas monorepo has **no i18n system**; every inbox string
   and both courtesy-mail templates are hardcoded English. **Decision: stay English-only across the
   inbox for now** —
   i18n will be built in **core first** as a monorepo-wide capability, and the inbox will adopt it
   then. Consequences baked into this plan: canned responses ship **single-body** (no translations
   table, Phase 4); courtesy mail stays English (no per-locale string table); Phase 11 is deferred
   to that future core work, not an inbox task.
2. **AI — DECIDED: yes, as a separate shared `@nuxtinator/ai` layer on OpenRouter.** AI is **not**
   inbox-owned. Build a new shared layer that **any** layer can consume (same pattern as `#crm` /
   `#email`), backed by **OpenRouter** (one OpenAI-compatible API, many models) to keep provider
   wiring simple. The **admin enables which models are available** (settings-driven, code-owned
   defaults + DB overrides per the persisted-state rule). Inbox is its first consumer. This splits
   the old Phase 10 into **10a** (build the AI layer) and **10b** (inbox consumes it) — see below.
3. **Drafts are the keystone.** Shared drafts (Phase 2) block outbound attachments, inline images,
   canned-response append-to-draft, and AI-draft persistence. Build drafts first within Phase 2.
4. **Composer is already rich text.** Correction to some scan notes: the reply composer is a
   `UEditor` with `:image="false"` (Thread.vue:139), not a plain textarea. Inline images therefore
   need *enabling + upload wiring*, not a composer rewrite; canned/signature HTML will render
   correctly in it already. This shrinks several UI estimates.
5. **Per-org, code-owned everything.** Every singleton config value (tag palette, AI model) and
   every brand string must be a **core_settings** override (namespace `inbox`) with a code-owned
   default — per the repo's persisted-state rule. Write JSON settings with `sql.json` (project gotcha).

---

## Already done and solid (don't rebuild)

For orientation — these are verified solid: conversation list filters/sort/pagination,
rail/badge counts (six-FILTER single query), search (subject + counterparty, minus CRM-name — see
5.x), the whole inbound durability choreography (dedupe → thread → claim-row → S3 → side-effects),
signature-verify + replay handling, sender classification (contact/held), auto-ack + auto-responder
gates, the queued-row-is-the-job send sweep with atomic claim + backoff, spam blocklist + close +
reopen-as-closed, channel-strict threading, and the auth-proxy attachment download. Load-bearing
details: reply_token is never exposed in payloads; unblock un-strands sibling threads; From
display names are quote-stripped. The decisions in [dev.md](dev.md) stand.

---

## Phase 0 — Correctness fixes  (~47k)

Small, mostly independent, each closes a real defect. Do first.

- **Outbound reply stuck on "Sending…" until manual refresh (~10k). [reported, confirmed]**
  Root cause: `useInboxThread.reply()` POSTs a `queued` message then `refresh()`es immediately —
  but the croner send sweep delivers asynchronously (`INBOX_SEND_SWEEP_SECONDS` default **20**), so
  the immediate refetch always catches the row still `queued`, which `MessageBubble.vue:33` renders
  as "Sending…". Nothing re-fetches after the sweep runs, so the badge freezes until a manual
  refresh (by which time it's `sent`/`delivered`). Compounding: `MessageBubble` has **no badge for
  `sent`** (only queued/delivered/failed/held), so locally on Mailpit (no delivery webhook) a
  successfully-sent reply shows *no* confirmation after refresh. **Fix:** after a reply — or whenever
  the thread holds a non-terminal outbound message — run a bounded poll (~2-3s interval, ~60s cap)
  that `refresh()`es until every outbound message settles (sent/delivered/failed); add a "Sent"
  badge. Secondary: Thread.vue's `sending` ref is decorative (`emit('reply')` is synchronous, so the
  Send button's `:loading` flips off instantly and never reflects the POST) — drive loading from the
  actual await.
- **Replying doesn't clear `needs_review` (~1k).** `messages.post.ts` never calls
  `inboxSetNeedsReview(id, false)` on send, so a held-then-answered thread stays in the "held"
  count/filter and inflates the (status-independent) rail badge until manually cleared.
  **Preserve:** clear on *send only*, never on draft-save.
- **`constrainImages` on outbound HTML (~3k).** Inject `max-width:100%;max-height:480px;height:auto;`
  onto every `<img>` in the final outbound body (email clients ignore `<style>`/external CSS, so the
  cap must be per-tag). Live bug today: the sanitizer allowlists `<img width/height/style>`, so
  full-size inbound images survive uncapped into quoted history on replies. **Preserve:** append the
  cap *last* inside an existing `style` (wins over sender styles); handle both quote styles + self-closing tags.
- **Attachment download filename sanitizer (~2k).** `attachments/[id].get.ts:27` strips `["\r\n]`
  but **not backslashes** and does **not** length-cap — a trailing `\` escapes the closing quote of
  the `Content-Disposition` filename. Fix: also strip `\`, slice to 200 chars.
- **Auto-responder held-branch too broad (~2k).** Target closes held mail on the *broad*
  `isAutoResponderOrBounce` flag (inbound.post.ts:254/360), silently swallowing DSNs and
  `Precedence: list/bulk` from strangers that should surface for review. Fix: close the held branch
  on the *vacation subset* only (two-line change), so DSNs land held + needs_review + notify.
- **Boolean query coercion (~1k).** List route uses `z.coerce.boolean()` for `held/unassigned/mine`,
  so `?held=false` coerces to **true** (any non-empty string is truthy). Harmless with the current
  UI (only ever sends `true`) but inverts the filter for raw API callers. Use an explicit
  `'true'|'1'` check.
- **Ship an `inbox_agent` static role (~3k).** An "Inbox Agent" role bundling
  `inbox.access + inbox.send`; target registers only permissions + default grants, so an org must
  hand-assemble a custom role to staff the inbox. Add one `registerStaticRole({ key: 'inbox_agent',
  permissions: [...], source: 'inbox' })` in `register-inbox.ts` (core's roles-registry exists for
  this — would be the first app layer to use it; verify the admin role-assignment UI lists app-static roles).
- **Spam verdict feedback + unmark `needs_review` (~5k, see Phase 1 for the log).** Add success
  toasts ("Marked as spam"/"Removed from spam" — target only toasts on failure) and clear
  `needs_review` on *any* unmark, not just when the requested status is `closed`
  (index.patch.ts:57 only clears in the closed branch).

## Phase 1 — Triage audit trail  (~30k)

Cheap, and unblocks the activity feed (Phase 7) and per-record activity reads. Core's `logEvent`
is already imported in the inbox layer (used only for `inbox_webhook_rejected` today).

- **Activity logging on every triage mutation (~15k).** Write `activity_logs` rows
  (table `conversations`/`inbox_conversations`) for: status change (`Status → X`), assign/unassign
  (one field, two messages, carry `assigned_user_id`), spam/unspam (carry the **channel value**, not
  a FK — the `inbox_blocked_senders` row and its `created_by` are deleted on unblock), reply queued
  (`direction: outbound`), conversation created (`source` + recipient). **Preserve:** `logEvent`
  never throws (logging must not break the flow); **pass the tenant tx as executor** or multi-mode
  audit rows get `org_id NULL`; log conversation-create *before* the fallible queue step so a failed
  first send still leaves an origin trail; system/webhook rows use `userId=undefined`.
- **Inbound activity trail (~6k).** One `logEvent` in tx A after conversation creation (origin:
  `inbound_email` + received-on address) and one in tx C after classification
  (`Inbound email (<outcome>[, auto-reply → closed])` + authenticated flag). Log-before-message
  ordering is the point — an empty shell from a failed ingest becomes explainable.
- **Per-record activity read endpoint (~12k).** `GET /api/inbox/conversations/:id/activity` under
  `withOrgPermission('inbox.access')` (RLS scopes rows to the org), joins users for display_name,
  `ORDER BY timestamp DESC LIMIT 100`, normalizes bigint-string timestamps to int + string metadata
  to parsed JSON. **Preserve:** the table allowlist is the security boundary — never a generic
  read-any-table endpoint.

## Phase 2 — Composer pipeline: drafts + attachments + inline images  (~230k)  ⭐ user-flagged (images)

The keystone. Build **drafts first**, then the two attachment tracks on top. In the target's
"the message row is the send job" model, uploads must bind to a `draft`-status row *before* it
flips to `queued` (uploading against an already-queued row races the sweep).

### 2a. Shared draft lifecycle (~55k)
Drafts are `inbox_messages` rows at `status='draft'`, **shared across all staff** (no user filter).
`status='draft'` already exists in the enum and list/count queries already exclude it; the partial
unique on `email_message_id` already anticipates NULL-id draft rows. Missing: the create/update/
list/delete/promote API + thread payload + composer draft UI (chips, autosave, load, draft-id reuse
on send).
- API contract (mirror `messages.post.ts`): save+no id → create; save+id → update (body + from_email
  only, COALESCE keeps from_email if absent); send+id → apply latest edits then flip to `queued`;
  delete scoped by `(id AND conversation_id AND status='draft')`.
- **Preserve (all load-bearing):** the `status='draft' AND conversation_id = path` guard on
  update/delete/promote prevents editing/deleting a sent message or queueing message-of-conversation-A
  onto conversation-B; promote isn't atomic but the send-time atomic `queued→sent` claim makes only
  one send win; sending merges latest composer edits over stored (`body_html ?? draft.body_html`);
  the files flow *requires* drafts (UI persists a draft so attachments bind to a `draft_id`, then sends it).

### 2b. Outbound file attachments (~90k = upload 45k + re-attach-at-send 20k + file UI 25k)
- **Upload endpoint** `POST /api/inbox/conversations/:id/attachments` (multipart `{file, draft_id}`,
  `inbox.send`): validate draft_id int, file present, filename **not** in the blocked-executable
  regex `/\.(exe|bat|cmd|com|scr|js|jar|vbs|ps1|sh|msi|dll)$/i` (400), size ≤ 25 MB (400); require
  the draft to belong to the path conversation (404); upload → `uploads/<32hex>.<ext>` → insert
  `inbox_attachments` row. **Preserve:** the cross-conversation guard (also re-checked on send);
  browser-declared content_type stored untrusted (safe only because download forces octet-stream);
  blocked exts rejected on *upload* (vs silently skipped on *inbound* — different policy per direction).
- **Re-attach at send.** In the send processor's between-tx window, list the message's attachments,
  fetch each over a signed S3 URL, append as attachment parts. **Preserve:** any fetch failure
  **throws to fail/retry the whole send** (never let the thread falsely read "sent" with a missing
  file) — mark the message `failed 'Attachment fetch failed'` only on the final attempt; wire the
  throw into `inboxReleaseForRetry`'s backoff, not a jobs table; skip under VITEST. Contrast with
  inline images below (opposite policy).
- **Composer file UI.** Paperclip → hidden multi-file input → `pendingFiles`; on save/send,
  `ensureDraft()` then upload each file sequentially with `draft_id`. **Preserve:** re-pick replaces
  (no append/dedupe); `pendingFiles` cleared only after the whole loop, so a mid-loop failure leaves
  the full list pending (retry re-uploads the prefix → duplicate rows; accepted).

### 2c. Inline-image pipeline (~135k = upload 40k + serving 15k + CID embed 20k + editor UI 15k + magic-byte sniffer within upload)
- **Upload endpoints** (both `inbox.send`, field `image`): `POST /conversations/:id/inline-images`
  and a conversation-less `POST /inbox/inline-images` (for brand-new compose). Reject empty (400),
  > 10 MB (413), and **magic-byte-sniff** the bytes — only JPEG/PNG/GIF/WebP (415 otherwise). Key =
  `inline/<scope>/<32hex>.<sniffed-ext>` in the **private** bucket. Returns
  `{ url: '/api/inbox/inline-image/<key>' }`. **Must port `sniffImageMime`** (FF D8 FF / PNG 8-byte
  sig / GIF87a|89a / RIFF..WEBP, min 12 bytes) — core storage has **no** magic-byte sniffer, only
  string content-type matching. **Preserve:** never trust the browser Content-Type (a `.png`-named
  HTML/SVG must 415); extension derived from the *sniffed* mime, filename discarded; distinct
  400/413/415 codes surfaced in the editor toast. **Org-scope the key or verify org membership in
  the proxy.**
- **Serving proxy** `GET /api/inbox/inline-image/[...key]` (`inbox.access` — weaker than upload so
  any viewer renders thread images): guard `isInlineImageKey` (must start `inline/`, no `..`), fetch
  private object, serve with the **stored sniffed Content-Type** + `Cache-Control: private,
  max-age=3600`. **Preserve:** the prefix+traversal guard is load-bearing (without it the route is a
  read-any-key oracle into the private bucket — raw `.eml`, every attachment); serving the real mime
  is safe *only* because upload sniffed it. Must be `withOrgPermission` (a key-prefix-only guard
  leaks cross-org images if a key leaks). The existing `attachments/[id]` proxy can't serve these
  (it forces octet-stream).
- **CID embedding at send** (`embedInlineImages`): regex-scan the assembled HTML for proxy URLs,
  dedupe keys via a Set, fetch each, push an inline part where **`filename === cid`** (Mailgun
  requirement — use the object basename), rewrite every occurrence (relative *or* absolute) to
  `cid:<basename>`. The transport already supports cid parts + the Mailgun `inline` split; the
  sanitizer already allowlists `cid:` img src. **Preserve:** an unfetchable inline image is **left
  as-is and the send proceeds** (opposite of file attachments); dedupe → one part, N rewrites; run
  embed *before* `constrainImages` and *before* the shell wrap; skip under VITEST.
- **Editor UI:** enable images on `UEditor` (drop `:image="false"`), custom image button → hidden
  input `accept='image/jpeg,image/png,image/gif,image/webp'` → reset `input.value=''` → POST to the
  per-conversation or conversation-less endpoint → `editor.chain().setImage({src: res.url})`. Toast
  falls through `statusMessage → message → generic` so the 413/415 wording reaches the user. Cap
  rendered images at 480px in editor CSS to match `constrainImages`.

### 2d. S3 lifecycle cleanup (~15k, partial)
Target has **zero** `deleteFromS3` calls in the inbox layer — attachment objects and raw-MIME `.eml`
files (full-message PII) orphan forever. Core already exports `deleteFromS3` (wiring, not a new
util). Channel-strict threading keeps threads on contact deletion, so there is no contact-cascade
hook; add cleanup on **org deletion** and provide a GDPR-purge path.
**Preserve:** best-effort per key (one failed delete logs + continues; a key-gather failure never
blocks the delete); include raw `.eml` (biggest PII item). Note: inline/ composer images are never
DB-tracked and orphan by design.

## Phase 3 — Tags  (~112k)

Conversation tags with a per-org palette. On dev.md's Deferred list.

- **Schema (~5k of it):** add `tags jsonb NOT NULL DEFAULT '[]'` + GIN index to `inbox_conversations`
  (column rides the already-RLS'd table — **no `_T` rescope needed**). Palette (slug→{name,color})
  lives in **core_settings** namespace `inbox` (not an `app_config` doc, not a table), written with
  `sql.json`.
- **Palette service + API (~40k):** `slugifyTag` (kebab, the stable stored key so renames don't break
  assignments); 7-color closed set with `neutral` fallback applied on read *and* write; list/create/
  delete endpoints gated `inbox.access` (palette management is deliberately gated at *view* level).
  **Preserve:** create is **create-or-return by derived slug** (idempotent, never overwrites color —
  inline create-on-assign can't duplicate); empty slug (name `!!!`) → 400; delete strips the slug from
  every conversation via the JSONB `-` operator *even for non-palette slugs* (cleans orphans);
  `sanitizeSlugs` drops unknown/non-string, dedupes, preserves order (API silently narrows, never 400s);
  list defends a corrupted palette doc (non-array → [], bad color → neutral).
- **Set-tags + counts + filter (~23k):** `PUT /conversations/:id/tags` (whole-set replace through
  `sanitizeSlugs`, returns the sanitized set so the client adopts it); `tag-counts` via
  `CROSS JOIN LATERAL jsonb_array_elements_text` **excluding only `spam`** (tags are cross-status
  folders); `tag` filter param → `tags @> sql.json([tag])` (GIN, mind the `::text::jsonb` binding
  gotcha from CRM). **Preserve:** counts ignore status *except spam* — porting the count without the
  UI's "selecting a tag resets status→all" produces mismatched badges.
- **UI (~44k):** rail tag folders (colored dot via a **static** Tailwind class map — dynamic
  `bg-${c}-500` gets purged), list-row chips, `InboxTagPicker` popover (toggle list, inline create
  with color swatches, two-step delete confirm). **Preserve:** selecting a tag resets *both* scope
  and status to `all`; scope buttons read inactive while a tag is active; palette deletion triggers a
  full list reload (rows' chips changed server-side); adopt the server's returned tags after PUT.
- **Bonus already-done:** `source` column exists and is written on every create path — just add the
  **source badge UI** (`contact_form`/`inbound_email`/`staff`), currently rendered nowhere (~2k).

## Phase 4 — Canned responses  (~54k)

Shared (org-wide) reply snippets. `inbox.send`'s description already promises "manage canned
responses", so permission wiring pre-exists.
- **Schema + service (~12k):** **DECIDED — single-body, no translations table** (i18n is deferred to
  future core work, cross-cutting #1). One `canned_responses` table (`title`, `body_html`,
  `created_by SET NULL`, timestamps) + `_T` org rescope. No translations table and no language
  select. If/when core i18n lands, revisit.
- **CRUD API (~16k):** list (ORDER BY title, batch-fetch translations), create/update (partial:
  title-only bumps updated_at; `translations: undefined` leaves them, `[]` wipes),
  replaceTranslations (delete-then-reinsert). **Preserve:** list early-returns `[]` when no parents
  (avoids `IN ()` syntax error); PUT existence-check before body parse; `created_by` is `SET NULL`
  (shared asset survives user deletion); the tenant tx makes the replace atomic.
- **Manager modal + composer picker (~22k):** two-pane manager (opened from the header,
  `inbox.send`-gated), single body field (no language select); a picker in the reply toolbar.
  **Preserve:** picker hidden when list empty and on fetch failure (degrades silently, no error
  toast); **append** to the draft with `<br>` (never replace); reset selection after insert so the
  same item re-inserts. Canned HTML rides the existing write-time sanitize — no extra work.

## Phase 5 — CRM integration  (~68k)  ⭐ user-flagged

Surface conversations on the contact record and reply/compose from there. dev.md defers this pending
perms-v2 — **which has landed on this branch** (commits 24e82d2..884f037; `[type]/[id].vue` already
consumes server-evaluated capabilities). Blocker cleared on the working branch (not yet on master).

- **`registerCrmDetailPanel` seam in CRM (~15k).** No extension point exists — `crm/[type]/[id].vue`
  is a fixed `CrmRecordHeader → CrmFieldSection loop → CrmConnectionsPanel → CrmTimeline` (verified).
  Core's six registries are server-side and can't carry Vue components, so build a **new client-side
  registry**: a module-scope array behind the `#crm` alias (`app/utils/crm-manifest.ts`) +
  `registerCrmDetailPanel({ id, recordTypes, component, order })`; inbox registers via a Nuxt app
  plugin passing the imported component object; `[id].vue` renders matching panels
  (`v-for`/`<component :is>`) after `CrmConnectionsPanel`. **Preserve:** optional both ways (CRM
  renders zero panels when nothing registered; inbox depends on CRM, never the reverse); dedupe by
  panel id to survive HMR/repeated plugin runs; panels self-gate on `inbox.access` client + server
  and render nothing (not an error card) on 403.
- **Contact-page conversations endpoint + panel (~35k).** `GET /api/inbox/records/:recordId/conversations`
  under `withOrgPermission('inbox.access')`. `inboxListConversations` already computes the exact
  list-item shape and its filter already accepts a single `channelId` — **widen `channelId` to an
  array** and resolve the record's email channel ids via `crm_contact_channels` (a contact can link
  several addresses; channel-strict threading means parallel threads per address — surface all).
  **Preserve:** snippet + message_count exclude `status='draft'` in SQL; order `last_message_at DESC
  NULLS LAST, created_at DESC` (shells must not sink/crash on null); include spam in the panel (full
  history) but hide the quick-reply on spam rows; permission-*hidden* not permission-erroring; refetch
  the badge count after compose/reply.
- **Inline quick-reply from the panel (~10k).** Expandable textarea → the existing
  `/conversations/:id/messages` endpoint. **Preserve:** convert plain textarea input to markup
  (newline→`<br>`, wrap `<p>`) client-side or the reply arrives as one line (the server sanitizes but
  doesn't add structure); hide on spam rows; refetch after send (status flips to pending).
- **Compose-new-to-contact (~8k, partial).** Backend is ready (`POST /api/inbox/conversations`
  `channelId` mode). Missing: a locked-recipient mode in `ComposeModal` (only free-text `toEmail`
  today) and the contact-page entry point. **Preserve:** hide/disable compose when the record has no
  email channel link; preselect the `is_primary` channel; consider `recordCrmActivity` on
  create for CRM-timeline parity (channelId mode logs nothing today).
- **Search parity (~8k, from Phase-1-adjacent).** List search currently misses the linked CRM
  contact's record name and the contact's *other* channel values — "John Smith" (mail client sends
  "JS") isn't findable by CRM name. Join `crm_contact_channels → crm_records.name` + sibling channels.

## Phase 6 — Per-user identities & signatures  (~93k)

Per-user sending aliases + HTML signatures; also **restores alias-routed inbound auto-assignment**.
On dev.md's Deferred list.
- **Data model (~10k):** an `inbox_identities` per-org table (`user_id`, `alias`, `signature`) +
  `_T` rescope making `unique(alias)` → `unique(org_id, alias)` (same reason `inbox_T002` exists).
  Not an ALTER on core's `users`.
- **Management API + `/me` + assignees alias (~24k):** `PUT /api/inbox/identities/:userId` — **split
  permission model**: alias changes (routable = attack surface) are admin-gated; a user may edit only
  their *own* signature (`inbox.send`). `GET /api/inbox/me` (`inbox.access`, one tier below send, so
  read-only agents see why no signature attaches). **Preserve:** validate alias `/^[a-z0-9][a-z0-9._-]*$/i`;
  **reject reserved local-parts** (`contact`, `bounce`, `notifications`); lowercase on write +
  case-insensitive match (MTA case-folding); unique-violation →
  friendly 400; log only actually-changed fields; `null` clears vs `undefined` leaves untouched.
- **Outbound From selection + signature (~29k):** `from_identity: personal|contact` on both compose
  endpoints; personal → `<alias>@<inboxDomain>`, **hard fallback to contact when no alias**; append
  signature `<br><br>` at **queue time, personal sends only**. **Preserve:** From address snapshot at
  compose time onto `from_email` (an admin removing the alias later doesn't change a queued send) but
  display name re-derived at send time from current display_name — don't collapse this split;
  case-insensitive `from_email == contactAddress` detection; **keep the target's quote-stripping** on
  display names (an unescaped quote in a display name is a From-header injection bug); signature
  baked into stored `body_html` (not `body_text`), sanitized at the outbound sink.
- **Composer From selector + signature notice (~18k):** USelect over From options (shown only when
  >1); three-state signature notice (attach/none-personal/contact) with a preview toggle;
  `defaultFromIdentity` continuity heuristic (default `contact` unless a prior non-draft outbound
  differs from the contact address → `personal`). **Preserve:** the preview renders the agent's own
  signature via `v-html` (self-XSS only); build the UI From
  label from the *same source the server sends* or the preview lies.
- **Inbound alias routing → auto-assign (~9k):** tokenless mail whose local-part base ≠ contact base
  → look up the alias's user → a **new** conversation is assigned to them (flips notification from
  broadcast to assignee-immediate). **Preserve:** reply-token beats alias beats References; contact
  base + `bounce@` never resolve as aliases; alias affects new conversations only (not the reused
  empty-shell branch — decide deliberately); run the lookup **inside the org-scope tx**
  (same alias can exist in two orgs).

## Phase 7 — Notes, activity feed & notification enrichment  (~200k)

- **Internal notes on conversations (~60k):** an `inbox_comments` table FK'd to `inbox_conversations`
  `ON DELETE CASCADE` (target keeps threads on contact deletion, so no cleanup hook needed — only
  org-cascade). Tiptap JSON body **sanitized server-side** (the XSS boundary), author or
  `author_label` for system notes, own-comment-only edit/delete with an `(edited)` marker. CRM's
  `crm_record_comments` + `comments.ts` (keyset cursor pagination, 10k cap, author-label-wins) is the
  in-repo model to adapt. **Preserve:** the empty-tiptap-doc guard (incl. single-empty-paragraph);
  system notes (null user) never editable.
- **@Mentions in notes (~25k):** extract mention user-ids from the *sanitized* doc (extracting from
  the raw doc would notify via stripped nodes), filter self-mentions, notify.
  `createNotification(email:'immediate', actorId)` gives bell + email + self-mention suppression
  for free. Point the mention link at the inbox conversation route.
- **Woven notes + activity feed UI (~30k):** a "Notes & Activity" tab merging comments
  (`record_type='conversation'`) + activity (`table='conversations'`) into one newest-first timeline.
  CRM's Timeline/ActivityEntry/CommentBubble/CommentComposer are the building blocks. **Preserve:**
  normalize timestamps (comment ISO string vs activity epoch-ms) before sorting or you get NaN sorts;
  `Promise.allSettled` so one failed stream doesn't blank the other; distinct key namespaces.
  (Depends on Phase 1's activity logging + the notes table.)
- **Assignee-notification enrichment (~25k, partial):** the notification exists (bell + immediate
  email) but the email body is just the subject. Add a plain-text message excerpt, attachment list,
  sender address, and the "New reply:" vs "New message:" subject distinction. Core rows are snapshot
  title/body/link — rich HTML would need an inbox-owned mailer. **Preserve:** assignee missing/no-email
  → no-op (not retry-forever); note the target's at-most-once gap (notification write is in tx C —
  a crash between S3 persist and tx C drops it silently).
- **Per-user notification preferences (~40k):** a **core-level** prefs blob (code-owned defaults,
  DB stores only explicit choices — the repo's persisted-state pattern) + profile endpoints/UI, so a
  user can opt into email for unassigned/held inbox mail (today the bell-only broadcast is
  unconditional). This is a core change, not inbox-only. **Preserve:** PATCH validates each key is a
  real boolean, 400s if no recognized key; admin PUT audits per-changed-key with readable labels.

## Phase 8 — Suppression admin & deliverability hardening  (~100k)

The suppression *write* path works for inbox-originated sends; the gaps are admin visibility,
recovery, and repeat/multi-org bookkeeping. (Consent double-opt-in, ~50k, is really Phase 9's
contact-form dependency — listed there.)
- **Suppression admin list (~30k):** `GET /api/inbox/suppressions` (or CRM-side) org-wide, joining
  `crm_channel_suppressions → crm_channels → crm_contact_channels → records` for "who is this
  address". Not on any deferred list — an unlogged gap. **Preserve:** include registry-only channels
  (claimed, never linked); show reason + latest detail + since + count.
- **Un-suppress / clear a false-positive bounce (~20k):** currently **impossible without SQL** — CRM's
  `clearSuppression` throws for any reason except `manual` and its UPDATE filters `reason='manual'`,
  so bounce/complaint suppressions are unclearable through every code path. Add a producer-authorized
  clear that bypasses the manual-only policy and records who/when. **Preserve:** preserve `bounce_count`
  across clears (flappy-address history); 404-when-not-suppressed; the schema already supports
  history-preserving clears (`cleared_at` + partial unique).
- **Bounce/complaint write-path hardening (~18k, partial):** three verified gaps — (1) repeat bounces
  are silently dropped (no `bounce_count`, detail/reason/timestamp never refreshed; an admin
  diagnosing sees a stale first message); (2) the scope loop **breaks at the first scope that acted**,
  so a multi-org address is suppressed/unsubscribed in only the first scope scanned (one loop fix
  covers both suppression and unsubscribe fanout); (3) `suppress()` is first-write-wins so a complaint
  following a bounce keeps `reason='bounce'` (should upgrade to `complaint`).
- **Suppression visibility on the contact record + timeline (~20k, partial):** the data (reason/
  detail/source/created_at) already exists in the DB but `consent.get.ts` exposes only
  `suppressed: boolean`; expose the detail, add a "Not receiving" badge on record list/detail, and
  write a `recordCrmActivity` entry on suppress (nothing is logged today). Per-channel model means one
  suppression fans out to several linked records — decide record-fanout vs channel-level timeline.

## Phase 9 — Public contact-form endpoint + `#inbox/server` barrel  (~45k + 50k consent)

`POST /api/contact` (or org-scoped) — dev.md defers this but undersells it.
- API-key-gated (`X-API-Key`/Bearer, server-to-server, **no CORS**), email regex-validated, ISO
  country alpha3→alpha2 normalize, find-or-create the email channel via `claimChannel`, consent
  through the CRM consent kernel, subject = first line truncated to 120, create conversation
  `source='contact_form'` + first inbound message, enqueue **localized** auto-ack (in the form's
  language) + staff notification. **Preserve:** activity-log the conversation origin *before* the
  first message insert; job-enqueue failures caught + logged, never fail the POST (submission never
  lost); unknown country → null not error; subject fallback "Contact form message".
- **Double-opt-in consent (~50k):** `crm_channels` already has `verification_token_hash` +
  `verification_expires_at` columns (dormant — nothing reads/writes them). Add token generate/consume
  + verification email, sent only when consent was requested AND the address is unverified.
  **Design constraint:** the target stores a token *hash*, so a still-valid plaintext token can't be
  reused for dedupe — use reissue-and-overwrite with a resend throttle.
  **Preserve:** verification is ownership proof, strictly separate from deliverability — the delivery
  webhook must never call `markChannelVerified`; `verified` is forward-only.
- **`#inbox/server` barrel:** export the conversation-creation + channel-claim helpers so a future
  forms layer can import them (the reason this endpoint is a clean seam).

## Phase 10 — AI: shared `@nuxtinator/ai` layer (OpenRouter) + inbox consumption  (~340k)

DECIDED (cross-cutting #2): AI is a **separate shared layer**, not inbox-owned. Split into **10a**
(build the layer — reusable by any layer) and **10b** (inbox's AI features consume it). 10b needs
drafts + the `ai_*` columns (Phase 2). Gate everything on config.

### 10a. The `@nuxtinator/ai` shared layer  (~60k)
A new optional layer alongside `email-*`/`crm`, exposing an `#ai` / `#ai/server` alias any layer can
import (same resolution pattern as `#crm` / `#email`). Backed by **OpenRouter** (one OpenAI-compatible
chat-completions + tool-calling API; single `OPENROUTER_API_KEY`).
- **Client + helpers (~15k):** `isAiConfigured()`, `complete()/generate()` with **forced tool-call**
  support (OpenRouter tool calling replaces Anthropic's `tool_choice`), streaming optional, error
  mapping. A throwing fallback in core-style when no key is set (mirrors `#email`). **Absorbs/replaces
  the `context` layer's ad-hoc `anthropic-client.ts`** — that becomes a thin consumer or is retired.
- **Admin model enablement (~30k):** the admin picks which models are available (register an admin
  section via core's admin-section registry). **Persisted-state pattern:** code ships the catalog +
  a default enabled set; `core_settings` (namespace `ai`) stores only the admin's explicit
  enable/disable + the per-feature model choice (e.g. `inbox.draftModel`) — no migration to add a
  model. Per-feature model resolves from the enabled set at request time (no redeploy to change).
- **Alias/exports/fallback wiring + tests (~15k).**
- **Preserve:** some models reject sampling params
  (`temperature`) — OpenRouter surfaces the provider error, so guard per model rather than always
  sending; error triage (429/5xx → retryable 502; not-configured → 503; else 500); model read
  per-request. Prompt caching: OpenRouter passes Anthropic `cache_control` through on Anthropic
  models (a no-op elsewhere) — keep the byte-stable grounding prefix regardless so caching-capable
  models hit.

### 10b. Inbox AI features (consume `#ai`)  (~280k)
All calls go through `#ai/server` instead of an inbox-owned client; the forced-tool pattern
(`submit_draft` / `submit_knowledge_entry`) maps to OpenRouter tool calling.
- **Grounding store + sync (~30k):** `grounding_documents` table (**genuinely needs a `_T` rescope**
  — both `source` + `doc_key` are externally controlled, so unique → `(org_id, source, doc_key)`);
  per-org configurable source-URL list in core_settings; HTML→text; upsert + prune. **Preserve:**
  per-slug try/catch (one page failure never aborts; upsert-only-on-success keeps the prior snapshot
  through an outage); empty body = failure, not a blank overwrite; `deleteKeysNotIn` short-circuits on
  empty (never deletes everything).
- **Grounding pack + prompt-cache-aware cache (~25k):** tone guide + rendered pages + docs joined
  into a byte-stable prefix (deterministic sort — what makes the Anthropic `cache_control` prefix
  actually hit); 10-min TTL keyed on `max(fetched_at)` for cross-instance invalidation. **Preserve:**
  serve-stale-on-freshness-check-failure (availability over freshness); read the key *before* the
  snapshots (race guard); knowledge block is a *separate* cache_control block so adding an entry
  doesn't bust the static pack.
- **Knowledge table + CRUD + suggest (~40k):** `inbox_knowledge_entries` (FK `SET NULL` — knowledge
  outlives its thread; index the FK or every conversation-delete seq-scans it); CRUD (`inbox.access`
  read / `inbox.send` write); AI extraction that **proposes, never persists** (auto-save would break
  the PII review gate); `removed[]` surfaces stripped-PII types. **Preserve:** temperature 0 for
  extraction vs 0.4 for drafting; the same `stop_reason` triage; `ai_metadata` written with `sql.json`.
- **Draft-reply endpoint + `ai_*` columns (~28k):** `ai_generated BOOLEAN` + `ai_metadata JSONB` on
  `inbox_messages`; `draft-reply.post.ts` with `preview:true` returning *without* persisting (the
  modal's generate/refine loop leaves no stray drafts). **Preserve:** regenerate overwrites the slot
  **only when `status='draft' AND ai_generated=true`** (never clobbers a human draft — the boolean is
  a write-guard); prompt-bloat caps (direction 2k, base_draft 20k chars). Depends on drafts (Phase 2).
- **Generation core (~35k):** parallel inputs, cache_control'd system blocks, oldest-first thread
  framing, forced `submit_draft` tool. **Preserve:** `max_tokens 8192` headroom (a truncated
  forced-tool response yields *partial JSON, not an error* — explicit `max_tokens` stop check throws
  "cut off"); distinct `refusal` handling; empty-draft guard; the per-request **contact-record block
  is never in the cached prefix and excludes the email address** (data minimization).
- **UI (~92k):** AI draft modal (steer/refine, instruction accumulation, English-gloss column when
  non-en), add-to-KB modal (auto-suggest on open, PII shield), KB management page + grounding-refresh
  button, conversation-page AI badges/review panel/KB nav. **Preserve:** no auto-generate on modal
  open; refine passes the teammate's *current edits*; add-to-KB shown only on `pending|closed`
  (extract from resolved threads only); error toasts branch on 503/502.
- **Daily grounding scheduler (~10k)** + inbox-side config surface (~8k: per-org grounding source
  URLs + `inbox.draftModel` selection — the `OPENROUTER_API_KEY` itself lives in the 10a layer).

## Phase 11 — i18n & localized courtesy mail  (DEFERRED — core-first, not an inbox task)

Per cross-cutting #1, the inbox stays English-only until **core** grows an i18n system. When that
lands, the inbox adopts it: localize UI strings, the two courtesy templates (auto-ack, held-notice),
and the email shell's `<html lang>`, driven by a language hint on the channel/conversation. Nothing
to do in this layer now. Notes for later: `normalizeLocale` (collapse `pt-BR` → supported base,
default en); the ack must keep its auto-reply headers even when localized (or two vacation bots loop).

## Cross-cutting — tests & docs  (~100k, woven per phase)

Behaviors the target doesn't test yet. Add per phase, not as a lump: send-sweep hardening
battery (suppressed→failed, sanitization, claim guard, retry, held-sender-never-a-recipient, ~25k);
durable-ack error paths (503 retryable on persistence failure, 400 malformed, ~10k); compose/start
endpoint (~10k); auto-ack fires authenticated-only with RFC 3834 headers (~8k); staff-notification
targeting (~6k); positive References/In-Reply-To threading + closed-reopens-on-token-reply (~7k);
delivery `delivered`→state + never-verifies-channel (~4k); complaint→suppression idempotency (~4k).
Docs: write `email-inbox-setup.md` (EU-region values, troubleshooting, e2e checklist); add
`INBOX_SEND_SWEEP_SECONDS` and the AI/grounding env vars to `.env.example`. An **inbox seed script**
(~15k) matters — signed-webhook fixtures are otherwise the only way to get data in; seed
`crm_channels` + conversations under an org scope, idempotent by a marker domain.

---

## Recommended sequencing

```
Phase 0 (fixes, incl. the Sending… bug) ─┐
Phase 1 (audit) ───────────────────────── ┴─► Phase 7 needs 1
Phase 2 (drafts+images) ⭐ ─► Phase 4 (canned append) & Phase 10b (AI persist) need drafts
Phase 5 (CRM) ⭐ ─► needs the panel seam; independent of 2
Phase 6 (identities) ─► restores alias-inbound; Phase 5 quick-reply From improves after it
Phase 3 (tags), Phase 8 (suppressions), Phase 9 (contact form) — independent
Phase 10a (@nuxtinator/ai layer) ─► reusable by any layer; build independently, anytime
Phase 10b (inbox AI) ─► needs 10a + Phase 2
Phase 11 (i18n) — deferred to core
```

Front-load **Phase 0/1** (cheap, high-value — Phase 0 now includes the reported Sending… bug), then
the two flagged tracks **Phase 2 (images)** and **Phase 5 (CRM)**. Tags/canned/identities are
independent parallel tracks. **Phase 10a** (the shared AI layer) is a standalone deliverable that
pays off across the whole monorepo, buildable anytime; **10b** wires the inbox into it. Total
remaining ≈ 2.9M tokens (i18n now out of scope for this layer); ≈ 1.5M excluding the AI track.
