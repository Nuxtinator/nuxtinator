# Helpinator — requirements (discovery output)

A Chatwoot-style AI help chat: an embeddable widget answers visitors from a
context portfolio via OpenRouter, logs every conversation, and hands off to the
shared inbox when a human is needed.

Status: implemented 2026-09-29 (see README.md). Elevation requires `inbox.send` as well as `helpinator.manage`.

## Placement & dependencies

- Upstream layer at `layers/apps/helpinator`, added to go-apps `layers.ts`.
- Requires `context` + `ai`. `inbox` (→ `crm`) is **optional**: without it the
  handoff and manual elevation are hidden/unavailable.
- Multi-tenant: widgets are org-scoped; an org can have many widgets (one per site).
- Public endpoints resolve the widget id → org server-side and run inside that
  org's scoped tx (same pattern as inbox's contact-form API key).

## Widget record (admin-managed)

- Bound to exactly **one portfolio** and **one default section** (`section_key`).
  No per-page section override in v1 — use another widget.
- Allowed origins list; per-widget daily message cap.
- Appearance: primary colour, position (bottom-right / bottom-left); texts:
  title, greeting, input placeholder, handoff prompt.
- Optional per-widget extra instructions, layered on a fixed built-in system
  prompt that owns the guardrails (answer only from the portfolio, don't invent,
  offer handoff).
- All config is server-side. The embed is only
  `<script src="https://<host>/js/helpinator-widget.iife.js">` +
  `<helpinator-widget host="…" widget-id="…">`; the widget fetches its config on load.
- **Per-site styling:** each widget is styled to match the site it's placed on.
  Server-configured colour is the default; the widget also exposes CSS custom
  properties (e.g. `--helpinator-primary`, and friends) so the host site can
  fine-tune from its own stylesheet.
- Admin helper: embed snippet generator (copy button) + live preview — like
  the feedback layer's widget helper.

## Chat

- One AI feature `helpinator.chat` (org's model/key resolution via `#ai/server`).
- Default section preloaded into the system prompt. Tools are read-only:
  list sections + `load_section`, **hard-scoped to the bound portfolio in the
  tool handlers** (not just the prompt). No write/proposal tools.
- Streaming replies (`onTextDelta`), rendered as sanitized Markdown; replies in
  the visitor's language.
- History is server-authoritative, keyed by an anonymous session token. The
  widget caches token + messages in `localStorage` (keyed by widget id) to
  survive refreshes; "New conversation" clears it. Each turn sends only the new
  message.
- Abuse limits: per-IP/per-session rate limit, per-widget daily cap,
  per-conversation turn cap (~50), per-message length cap (~2,000 chars).
- Config endpoint reports `aiAvailable` / `handoffAvailable`; if AI isn't
  configured the widget shows a short "unavailable" state.

## Portfolio isolation (prompt-injection defence)

Principle: the model can only leak what is in its context or reachable by its
tools, so other portfolios are made **unreachable in code**, not forbidden in
the prompt.

- Tools take **no `portfolio` argument** — only `section_key`. The handler binds
  `portfolio_id` from the widget record server-side. (Do not reuse context's
  `load_section`, which accepts a model-supplied slug.)
- Helpinator uses its own narrow queries, always `where portfolio_id = <widget's>`;
  never context's multi-portfolio loader, never the context MCP tools.
- Section index and prompt contain only this portfolio — no other portfolio
  names or slugs anywhere in the model's view.
- Cross-org isolation via tenancy RLS: widget id → org, whole turn in that org's tx.
- The conversation records `portfolio_id` at creation; if the widget is rebound,
  old conversations end rather than silently switching.
- Session tokens are bound to one widget; a token from widget A is rejected on B.
- Bot reads **live** context tables (no published snapshot).
- The **whole bound portfolio is exposed** (no per-widget section allowlist).
  Rule: a helpinator portfolio contains public info only — everything in it,
  plus the widget's extra instructions, must be treated as extractable.
- Never load section comments, version history, or editor names.
- Required tests: fake calls `load_section` with a key that exists only in
  another portfolio → "unknown section"; tool schema has no portfolio param;
  system prompt contains no other portfolio's slug/name; cross-widget session
  token rejected.
- Prompt guardrails / output filtering are tone aids only, not a security boundary.

## Email & handoff

- "Still need help?" is always visible; the bot also suggests it when it can't answer.
- **Self-service handoff** → inbox intake util with `source='helpinator'`:
  transcript as first message, conversation `open` + **unassigned** (unassigned =
  needs dispatch; no tag). The typed address gets inbox's fixed auto-ack only:
  widget-name subject, no transcript (nothing proves the visitor owns the
  address, and a verified address can be any past correspondent). Needs the
  inbox app enabled for the org; limited to 3/day per mailbox (`+tag` and Gmail
  dots folded).
- At most one handoff per conversation. Afterwards the bot keeps answering with
  a "team will follow up by email" banner; later turns are not synced to inbox.
- Human replies go by email only — never shown in the widget.
- Staff are notified only on handoff (inbox's existing notifications).

## Admin log

- Read-only, per widget: transcript, sections loaded per turn, page URL, origin,
  user agent, email if given, link to the inbox conversation.
- IP used only for rate limiting — never stored raw (at most a salted hash).
- Kept indefinitely (no retention sweep in v1).

## Permissions

- `helpinator.access` — view logs. `helpinator.manage` — configure widgets, elevate.
- Defaults: admin both, member none.

## Upstream inbox change

- Extract contact-form intake into an exported server util accepting `source`,
  optional `extraMessage` (appended to the ack), skip-ack flag, and assignee.
  `contact.post.ts` calls the same util; its existing tests must keep passing.

## Out of scope (v1)

Human replies inside the widget, attachments, voice, per-widget model override,
per-page section override, staff notifications for new (non-handoff) chats.

## Open notes

- Should manual elevation also require `inbox.send`? (Recommended: yes — the
  admin lands in the composer.)
- Own CORS/origin-allowlist middleware (cf. `feedback-cors.ts`).
- Manual elevation sends no ack → no address-confirmation link → channel stays
  unverified (inbox composer will show it).
- Widget bundle weight: Vue + streaming + Markdown + sanitizer (e.g. DOMPurify).

## Risks

- AI cost: origin checks don't stop scripts; the daily cap is the real valve —
  surface usage vs cap in admin.
- Prompt injection can extract anything in the bound portfolio — portfolio must stay public-only (editor discipline, not code).
- Inbox's Mailgun inbound setup is a prerequisite for staff replies to thread back.
- Inbox intake refactor touches a public endpoint's internals.

---

# Implementation plan

## A. Inbox (upstream change)

1. `server/utils/inbox-intake.ts` — contact-form intake extracted into two kernel calls:
   - `inboxRecordIntake(tx, input)` — claim channel, optional consent, verification
     token, create conversation (`source`, `assignedUserId`), origin event, first
     inbound message (`message` text + optional `bodyHtml`), touch. Returns the ids
     and the ack context. Runs inside the caller's tx so a consumer (helpinator)
     can link its own row atomically.
   - `inboxAfterIntake(scope, created, { notify, ack, extraAckHtml })` — post-commit
     staff notification (own tx, swallowed) + auto-ack (fire-and-forget).
2. `inbox-courtesy.ts`: `extraHtml` on the ack context, appended after the standard body.
3. `contact.post.ts` becomes a thin caller of the two functions (behaviour unchanged).
4. Export both from `#inbox/server`; `INBOX_SOURCE_META.helpinator = Chat`.

## B. Helpinator layer (`layers/apps/helpinator`)

- `modules/inbox-bridge.ts` — aliases `#helpinator/inbox` to `server/bridge/inbox-real.ts`
  when `#inbox/server` is registered, else `inbox-stub.ts` (never imports inbox/crm).
- Migrations: `helpinator_001_create_widgets`, `_002_create_conversations`,
  `_003_create_messages`, `_T010_enable_tenancy` (all three tables).
- Utils: widgets (CRUD + appearance sanitising + public shape), sessions (random
  token, sha256 at rest, bound to widget), bot (prompt + single `load_section`
  tool bound to widget portfolio), limits (hashed-IP + session rate limits, daily
  cap), origins, transcript rendering.
- Public API `/api/v1/helpinator/widgets/:id/…` (CORS middleware, origin allowlist):
  `GET config`, `POST messages` (SSE stream or JSON; creates the conversation
  lazily and returns the token), `GET conversation`, `POST handoff`.
- Admin API `/api/helpinator/…`: widgets CRUD + portfolio/section picker
  (`helpinator.manage`), conversations list/detail (`helpinator.access`).
- Pages: `/helpinator` (conversation log), `/helpinator/conversations/:id`,
  `/helpinator/widgets`, `/helpinator/widgets/:id` (form, snippet, live preview).
- Embeddable `embeddables/helpinator-widget` (Vue custom element, marked + DOMPurify)
  → `public/js/helpinator-widget.iife.js`; CSS custom properties for per-site styling.
- Tests: isolation suite, public widget endpoints, admin CRUD, handoff/elevation.

## C. Wiring

- nuxtinator: root `workspaces`, `dev/layers.ts`, `dev/package.json`,
  `dev/vitest.config.ts`, `prod/layers.ts`.
- go-apps: `layers.ts` entry (fetch works once the layer is pushed/tagged upstream).

---

# Libraries — requirements + implementation plan (discovery 2026-09-30)

Status: implemented 2026-09-30 across `core/ai-fallback`, `ai`, `apps/context`
and `apps/helpinator` (see each README). Caps remain code constants
(`helpinator-bot.ts`, `assistant.ts`). Host follow-ups: pgvector image in
docker-compose (done), publish the layers and drop the `NUXTINATOR_*_PATH`
overrides from go-apps `.env`, pick an embedding model on Admin → AI, then
create the D.T library with its four URL entries.

Second phase. A widget no longer binds to one portfolio: it gets a list of
**libraries** — scraped websites or context portfolios — searched by vector
similarity, with one default library whose page index sits in the cached
prompt. Modelled on DiscipleTools/agent-ai (per-agent URL "context documents"
crawled into a vector store) but with the library abstracted out of the
widget, the store in Postgres/pgvector, and the pages themselves as the unit
the model reads (search finds the page, `load_page` reads it whole).

## Decisions (from discovery)

**Libraries**
- Own table, per org (RLS like every helpinator table). `kind` is `website`
  or `portfolio`. A portfolio library is a pointer (`portfolio_id`), no copy:
  page loads read `context_sections` live, chunks are the ones the context
  layer writes on section save.
- A website library holds URL entries (sources). Each entry crawls its start
  URL plus same-host links **one hop** deep, optionally restricted to paths
  under the start URL's path; per-entry max pages (default 200); a few
  concurrent fetches with a short delay; named user agent; robots.txt
  disallows respected; non-HTML skipped.
- Extraction: readability-style main content → markdown (headings and lists
  survive into chunks and into what the model reads).
- Pages are unique by URL within a library; the first entry to crawl a URL
  owns it, other entries skip it. Pages are **read-only** in the admin;
  corrections go in a portfolio-backed library.
- Re-crawl replaces the entry's page set: vanished pages deleted, unchanged
  pages (content hash of the extracted markdown) not re-embedded.
- Sync runs fire-and-forget inside Nitro with per-entry status
  (`idle | syncing | done | error`), page count, bytes, last synced, error
  message. A stale "syncing" never blocks a new sync (newest run wins via a
  run token). Per-entry re-crawl and a per-library "sync all".
- Deleting a library that a widget lists is refused (409).
- Admin: a **Libraries** nav item beside Widgets.

**Widgets**
- `library_ids[]` (allowed) + `default_library_id` (must be in the list);
  `default_section_key` kept, meaningful only when the default library is a
  portfolio. The old `portfolio_id` column goes; existing test widgets are
  deleted, not migrated.
- Cached system prompt = rules + the default library's page index (title +
  URL/key) + preloaded default section (portfolio default only).
- Every visitor message is **auto-searched** across all allowed libraries and
  the hits are injected as a non-cached system part; the model also has a
  `search` tool (rephrase / follow-up) and one `load_page` tool for pages and
  sections alike. No library argument on any tool: the allowed set is bound
  server-side.
- Caps are code constants for now (loads 3, searches 2, hits 8, page cap 40K
  chars); promote to settings after testing.
- Conversation log records searches and loads per assistant turn.

**Embeddings / search**
- Embeddings through the ai layer via OpenRouter `POST /embeddings`. The
  embedding model is a setting in both scopes, like the chat models: the host
  picks a default on **Admin → AI**, an org may override it on its own AI
  settings page (libraries and section chunks are org-scoped, so orgs never
  search each other's vectors and may differ). The section is shown only when
  a loaded layer registers an embedding feature (helpinator and context both
  do). Both pages warn on change and offer a re-embed button: the org page
  re-embeds that org, the host page re-embeds every org whose resolved model
  no longer matches its stored chunks.
- pgvector: prod is Railway's pgvector template; migrations run
  `CREATE EXTENSION IF NOT EXISTS vector` and fail hard without it. Dev
  compose and the test DB switch to `pgvector/pgvector:pg18`.
- Two chunk tables, one per owner: `context_section_chunks` (context) and
  `helpinator_library_chunks` (helpinator). Each chunk row stores the model id
  that produced it; a mismatch with the current setting is shown as stale.
  The ai layer exports `embed()` and the vector column helpers so neither app
  talks to OpenRouter or pgvector directly.
- Context sections embed **inline on save**, best-effort: a failure never
  blocks the save; the section shows "search index not regenerated" and a
  re-embed button.
- The context assistant gets the same auto-search + `search_sections` tool
  over its scoped portfolio.

**Initial content**: one website library with four entries —
`https://disciple.tools/` (path filter off), `/docs`, `/plugins`, `/news`
(path filter on). No GitHub sources.

## Held-back risks

- A 400-page default index is ~8K cached tokens per prompt; cap the index at
  `HELPINATOR_INDEX_MAX_PAGES = 400` and fall back to "search only" above it.
- Depth-1 from `/news` also captures pagination/category pages; the path
  filter plus a `?`-stripping normaliser limits it, pruning happens in admin.
- Date stamps in extracted bodies defeat the hash skip; hash the readability
  output, not raw HTML, and strip `<time>` elements.
- Fire-and-forget assumes one Nitro replica; the run token guard makes a
  second replica's concurrent crawl harmless (older run stops writing).
- Full re-embed of the D.T corpus (~500K tokens) costs cents; not a concern.

---

## Implementation plan

Order matters: A (ai layer) unblocks B (context) and C (helpinator); D is
devops. Each step lists files (paths under `layers/`), then tests.

### A. `ai` layer — embeddings primitive + model setting

1. **Types** — `core/ai-fallback/types.ts`: add
   ```ts
   export interface AiEmbedOptions { tx: AiDbClient; input: string[]; dimensions?: number }
   export interface AiEmbedResult { vectors: number[][]; model: string; dimensions: number }
   export interface AiEmbeddingModelInfo { id: string; name: string; dimensions: number | null; promptPrice: number | null }
   ```
   Widen `AiFeature` with `kind?: 'chat' | 'embedding'` (default `'chat'`).
2. **Fallback** — `core/ai-fallback/ai.ts`: `embed()` throws 503 like
   `complete()`; `getEmbeddingModelList()` returns `[]`;
   `resolveEmbeddingModel()` returns `''`; `isEmbeddingConfigured()` false.
3. **Embedding model list** — new `ai/server/utils/ai-embedding-model-list.ts`
   mirroring `ai-model-list.ts` but fetching `GET ${baseUrl}/embeddings/models`
   (cached 1h, stale-while-revalidate, VITEST seed `test/embed-small` with
   dimensions 8). Parse `id`, `name`, `pricing.prompt`, and the dimension
   hint when OpenRouter reports one.
4. **Setting** — `ai/server/utils/ai-settings.ts`: `AI_SETTING_EMBEDDING_MODEL
   = 'embedding_model'`, registered once and served in both scopes like the
   other model settings. `resolveEmbeddingModel(tx)` = org setting → host
   setting, first one still listed (an org on its own key may pick any listed
   embedding model; on the host key only the host's pick, so no
   host-enabled set for embeddings — one model is enough). Register it in
   `register-ai.ts` with `sanitizeModelId`.
5. **Client** — `ai/server/utils/ai-client.ts`: `embed(opts)` → resolves key
   (`getEffectiveApiKey`) and model, POSTs `${baseUrl}/embeddings` with
   `{ model, input, encoding_format: 'float', ...(dimensions) }`, batches input
   in groups of 64, maps errors with the same 502/500/503 contract, logs usage.
   VITEST → `ai-test-fake.ts` gains `aiFakeEmbed()`: deterministic 8-dim
   vectors from a string hash (so similarity tests are stable: identical text
   → identical vector; the fake also records calls in the log).
6. **Vector helpers** — new `ai/server/utils/ai-vectors.ts`:
   `toPgVector(v: number[]): string` (`'[0.1,0.2,…]'`),
   `vectorSql(v)` → `sql\`${literal}::vector\``, and
   `cosineDistance(colRef, v)` → `sql\`${col} <=> ${vectorSql(v)}\``. Also
   `AI_EMBED_DIMENSIONS = 1536` — the fixed column width; `embed()` always
   passes `dimensions: 1536` so any model with matryoshka support fits, and a
   model that can't is rejected at setting time (list parse marks it).
7. **Chunker** — new `ai/server/utils/ai-chunk.ts`: `chunkMarkdown(text, {
   maxChars: 2000, overlapChars: 200 })` → `{ ordinal, text, heading }[]`.
   Splits on `#` headings first, then paragraphs, then hard-wraps; pure,
   unit-tested.
8. **Exports** — `ai/server/exports/index.ts`: export `embed`,
   `isEmbeddingConfigured`, `getEmbeddingModelList`, `resolveEmbeddingModel`,
   `AI_SETTING_EMBEDDING_MODEL`, `AI_EMBED_DIMENSIONS`, `toPgVector`,
   `vectorSql`, `cosineDistance`, `chunkMarkdown`, and the new types.
   `ai/app/utils/ai-manifest.ts`: add `AiEmbeddingModelInfo` and the admin
   config shape fields below.
9. **Reindex registry** — new `ai/server/utils/ai-reindex-registry.ts`:
   `registerAiReindexer({ key, label, run: (tx, orgId|null) => Promise<{chunks:number}> })`.
   Context and helpinator register theirs; the admin "re-embed everything"
   button walks org scopes (same iteration as `notification-jobs.ts`
   `listOrgScopes`) and calls every reindexer. `getAiReindexers()` exported.
10. **Routes** —
    - `ai/server/routes/api/ai/embedding-models.get.ts` (auth) → list.
    - `admin/config.get.ts`: add `embeddingModel`, `embeddingAvailable` (any
      registered feature has `kind: 'embedding'`), and `staleOrgs` — orgs
      whose stored chunk models (reindexers' `currentModels(tx)`, add that
      method to the contract) differ from the model that resolves for them.
    - `admin/config.put.ts`: accept `embedding_model` (listed or '').
    - `org/config.get|put.ts`: same two fields for the org scope, plus
      `embeddingStale` for the active org.
    - new `admin/reindex.post.ts` (operator admin): fire-and-forget over the
      stale orgs (or all, with `{ all: true }`), each in its org scope;
      `org/reindex.post.ts` (`org.settings.write`): the active org only.
      Progress from `admin/reindex-status.get.ts` / `org/reindex-status.get.ts`
      (in-process state on a global symbol: running, per-org counts, last
      error).
11. **Settings pages** — `ai/app/pages/admin/ai/index.vue` and
    `ai/app/pages/@[orgSlug]/settings/ai.vue`: new "Embedding model" section,
    rendered only when `embeddingAvailable`. Picker over
    `/api/ai/embedding-models` (org page: "Use host default" clear entry);
    below it a warning alert: "Changing this makes the existing search
    indexes unusable until they are rebuilt". When indexes are stale, a
    danger alert with a **Re-embed** button (confirm modal, polls status):
    the org page for that org, the host page listing the stale orgs.
12. **Tests** — `ai/tests/unit/ai-chunk.test.ts` (headings, overlap, empty),
    `ai/tests/unit/ai-embedding-model-list.test.ts` (parse), `ai/tests/api/
    ai-admin.test.ts` extend: set embedding model, reject unknown id,
    reindex endpoint is operator-only.

### B. `context` layer — section chunks + assistant search

1. **Migration** `context_013_section_chunks.ts`:
   `CREATE EXTENSION IF NOT EXISTS vector;` then table
   `context_section_chunks (id uuid pk, section_id uuid fk context_sections
   on delete cascade, portfolio_id uuid, ordinal int, heading text, content
   text, embedding vector(1536), model text, created_at)`, unique
   `(section_id, ordinal)`, HNSW index `USING hnsw (embedding
   vector_cosine_ops)`. Also `ALTER TABLE context_sections ADD COLUMN
   index_state text NOT NULL DEFAULT 'none'` (`none|ok|stale|error`) and
   `index_error text`. `context_T013_tenant_scope_section_chunks.ts` applies
   the `enableTenantScoping` pattern.
2. **Schema** `server/database/schema.d.ts`: `ContextSectionChunksTable`,
   new columns on sections.
3. **Indexer** — new `server/utils/section-index.ts`:
   - `indexSection(tx, section)`: chunk → `embed()` → delete + insert chunks
     → set `index_state='ok'`; catches ai errors (503/502/500) and sets
     `stale` + message instead of throwing. Skips (state `none`) when
     `isEmbeddingConfigured()` is false.
   - `searchSections(tx, { portfolioIds, query, limit })`: embed query,
     `SELECT … ORDER BY embedding <=> $q LIMIT n*3`, collapse to one row per
     section keeping the best distance and snippet. **Exported** for
     helpinator (auto-imported like `getPortfolioSections`).
   - `reindexPortfolio(tx, portfolioId)` and the reindexer registration
     (`context.sections`) in `register-context.ts`, which also registers
     the embedding feature `{ key: 'context.embeddings', kind: 'embedding',
     label: 'Context — section search' }`.
4. **Hook** `saveSectionContent()` in `section-helpers.ts`: after the version
   insert, `await indexSection(tx, section)`. All six call sites (PUT,
   comments create, restore, proposals, MCP `update_section`,
   `bulk_update_sections`) get it for free. Section delete cascades chunks.
5. **Route** `POST /api/context/portfolios/:slug/sections/:key/reindex`
   (`context.write`) → `indexSection` and returns the new state.
6. **UI** `app/pages/context/[slug]/sections/[key]/index.vue`: when
   `index_state` is `stale`/`error`, a warning alert "Search index didn't
   regenerate: <error>" with a **Re-embed** button. Section GET returns the
   two new fields.
7. **Assistant** `server/utils/assistant.ts`:
   - `buildAssistantContext` gains `search_sections` tool `{ query }` (cap 2
     per turn) for section/portfolio scopes (all-scope: search across every
     portfolio the user can read — the existing `entries`). Results:
     `- \`key\` (Portfolio): heading — snippet` with a nudge to
     `load_section`.
   - `messages.post.ts` (`runTurn`): before `complete()`, run
     `searchSections` on the user message, append a **non-cached** system part
     `## Search hits for this message\n…` after the cached one (prompt prefix
     stays byte-stable). Skip silently when embeddings aren't configured.
8. **Tests** — `tests/sections/index.test.ts`: save embeds (fake), chunk rows
   present with model id; ai failure leaves `stale` and the save succeeds;
   reindex route clears it. `tests/assistant/search.test.ts`: hits injected,
   `search_sections` returns only scoped portfolio rows; RLS test for the
   chunk table in `tests/migrations/rls.test.ts`.

### C. `helpinator` layer — libraries, crawler, widget rebinding

1. **Migrations**
   - `helpinator_004_create_libraries.ts`:
     `helpinator_libraries (id, name, kind 'website'|'portfolio',
     portfolio_id uuid null fk context_portfolios on delete cascade,
     description text, created_by, created_at, updated_at)`.
   - `helpinator_005_create_library_sources.ts`:
     `helpinator_library_sources (id, library_id fk cascade, url text,
     restrict_to_path bool default true, max_pages int default 200,
     status text default 'idle', run_token uuid null, page_count int,
     bytes int, last_synced_at, last_error text, created_at)`, unique
     `(library_id, url)`.
   - `helpinator_006_create_library_pages.ts`:
     `helpinator_library_pages (id, library_id, source_id fk cascade, url,
     title, content text (markdown), content_hash text, bytes int,
     fetched_at)`, unique `(library_id, url)`.
   - `helpinator_007_create_library_chunks.ts`: `CREATE EXTENSION IF NOT
     EXISTS vector;` `helpinator_library_chunks (id, page_id fk cascade,
     library_id, ordinal, heading, content, embedding vector(1536), model,
     created_at)`, unique `(page_id, ordinal)`, HNSW cosine index.
   - `helpinator_008_widgets_to_libraries.ts`: `DELETE FROM
     helpinator_widgets` (test rows, per decision), drop `portfolio_id`, add
     `library_ids uuid[] NOT NULL DEFAULT '{}'`, `default_library_id uuid
     NULL`, make `default_section_key` nullable. Conversations:
     rename `portfolio_id` → `library_ids uuid[]` snapshot (`default_library_id`
     too) so a rebound widget still ends old conversations. Messages: add
     `searches jsonb DEFAULT '[]'` beside `sections_loaded` (rename that to
     `pages_loaded`).
   - `helpinator_T011_tenancy_libraries.ts`: `enableTenantScoping` on the
     four new tables.
2. **Schema** `server/database/schema.d.ts`: the four tables, widget/
   conversation/message changes, `HelpinatorLibraryKind`,
   `HelpinatorSourceStatus`.
3. **Libraries util** — new `server/utils/helpinator-libraries.ts`:
   zod inputs (`HelpinatorLibraryInput`: name, kind, portfolio_id?,
   description; `HelpinatorSourceInput`: url (http/https, ≤2000),
   restrict_to_path, max_pages 1–1000), CRUD, `helpinatorAssertLibraries(tx,
   ids, defaultId)` (all exist in org, default ∈ list), delete refuses when
   any widget's `library_ids` contains it (409), stats query (pages, chunks,
   distinct models).
4. **Crawler** — new `server/utils/helpinator-crawl.ts` (deps added to
   `package.json`: `@mozilla/readability`, `linkedom`, `turndown`,
   `robots-parser`):
   - `helpinatorNormalizeUrl` (strip hash, strip `utm_*`, trailing slash
     rule, lowercase host).
   - `helpinatorDiscover(start, opts)`: fetch start page, collect `<a href>`
     same-host links, apply path prefix when `restrict_to_path`, dedupe, cap
     `max_pages` (start page first).
   - `helpinatorExtract(html, url)` → `{ title, markdown }` via
     Readability → Turndown (strip `<time>`, nav/footer already gone).
   - `helpinatorRunSource(sourceId, orgId)`: sets `status='syncing'`,
     `run_token=new`, then in the background: robots check, fetch with
     concurrency 3 and 250ms spacing, 10s timeout, skip non-`text/html`;
     for each page: normalise, skip if another source in the library owns
     the URL, upsert by `(library_id, url)`, compare `content_hash`; changed
     or new → `chunkMarkdown` → `embed()` → replace chunks. Delete this
     source's pages not seen this run. Every write is guarded by
     `WHERE run_token = $mine` on the source row check so a superseded run
     stops. Finish: `status='done'|'error'`, counts, `last_synced_at`.
     Each unit of work opens its own short org-scoped tx (`withOrgContext`
     from `#tenant/server`, or plain `db` in single mode — same helper the
     inbox jobs use); nothing holds a tx across network calls.
   - `helpinatorSyncLibrary(libraryId)`: runs sources sequentially.
   - `helpinatorReindexLibraries(tx)` (reindexer `helpinator.libraries`):
     re-embeds every chunk's page content from the stored markdown, no
     re-fetch.
5. **Search** — new `server/utils/helpinator-search.ts`:
   `helpinatorSearch(tx, { libraries: {id, kind, portfolio_id}[], query,
   limit: 8 })` → embeds once, runs two queries (`helpinator_library_chunks
   WHERE library_id = ANY` and `searchSections` for the portfolio ids),
   merges by distance, collapses to one hit per page/section, returns
   `{ ref, title, url|null, library, snippet, distance }` where `ref` is
   `page:<uuid>` or `section:<libraryId>:<key>` — opaque ids the load tool
   accepts. Isolation: the library set is the caller's, never model input.
6. **Bot** `server/utils/helpinator-bot.ts` rewrite:
   - `helpinatorBuildBot(tx, { libraries, defaultLibraryId,
     defaultSectionKey, extraInstructions, handoffAvailable, userMessage })`.
   - Cached part: rules (updated: "answer only from loaded pages and search
     results"), `## Index of <default library>` (pages: `- page:<id>: Title
     (url)`; portfolio: `- section:<lib>:<key>: Title — description`; capped
     at `HELPINATOR_INDEX_MAX_PAGES`), `## Loaded content` with the default
     section when the default library is a portfolio.
   - Non-cached second system part: `## Search hits for the latest message`
     from `helpinatorSearch(userMessage)` (omitted when embeddings aren't
     configured). `system` becomes `AiTextPart[]` of two parts.
   - Tools: `search { query }` (cap `HELPINATOR_SEARCHES_PER_TURN = 2`),
     `load_page { ref }` (cap 3, 40K chars; `page:` → pages table filtered
     by `library_id = ANY(allowed)`; `section:` → `context_sections` filtered
     by the library's `portfolio_id`; anything else → "unknown ref").
   - `pagesLoaded: { ref, title }[]`, `searches: string[]` for the log;
     `describeToolCall` → "Searching…" / page title.
   - `helpinatorAiReady` also requires `isEmbeddingConfigured` when any
     website library is allowed (a portfolio-only widget still works
     without embeddings, search just returns nothing).
7. **Widgets util** `helpinator-widgets.ts`: input → `library_ids`
   (1–20 uuids), `default_library_id`, `default_section_key` optional;
   `assertBinding` → `helpinatorAssertLibraries` + section check when the
   default is a portfolio; update ends open conversations when the library
   set or default changes; `helpinatorPublicConfig.aiAvailable` checks
   `library_ids.length > 0`.
8. **Conversations util**: snapshot `library_ids`/`default_library_id` on
   create; `helpinatorIsLive` compares the snapshot to the widget; insert
   message takes `pagesLoaded` + `searches`; transcript mappers updated.
9. **Public route** `messages.post.ts`: pass the widget's libraries (loaded
   via `helpinatorGetLibraries(tx, conversation.library_ids)`) and the user
   message to the bot; record `pagesLoaded`/`searches`.
10. **Admin routes** (`withOrgPermission … 'helpinator.manage'`, under
    `server/routes/api/helpinator/`):
    - `libraries/index.get|post.ts`, `libraries/[id].get|put|delete.ts`
      (get includes sources with status + stats).
    - `libraries/[id]/sources/index.post.ts`, `sources/[sid].delete.ts`,
      `sources/[sid]/sync.post.ts`, `libraries/[id]/sync.post.ts` (both
      return 202 immediately), `libraries/[id]/pages/index.get.ts`
      (paged: url, title, bytes, fetched_at), `pages/[pid].get.ts` (markdown,
      for the "View" link), `pages/[pid].delete.ts` (prune; the URL is
      re-added on the next crawl unless the source is narrowed).
    - `portfolios.get.ts` stays (for the portfolio-kind picker).
11. **Admin UI**
    - `register-helpinator.ts`: nav item "Libraries" → `/helpinator/libraries`
      (order 15, `helpinator.manage`); register the embedding feature
      `{ key: 'helpinator.embeddings', kind: 'embedding', label:
      'Helpinator — library search' }`; the reindexer.
    - `app/pages/helpinator/libraries/index.vue`: list with kind badge,
      page/chunk counts, "New library".
    - `app/pages/helpinator/libraries/[id].vue`: name/description form;
      for portfolio kind a portfolio select; for website kind the source
      list in the agent-ai shape (url, `N pages`, size, last synced, status
      badge, Re-crawl / Remove, plus "View pages" drawer), an "Add URL" row
      with the path-restrict toggle and max pages, a **Sync all** button,
      an alert when stored chunk models ≠ current embedding model with a
      pointer to Admin → AI. Polls `GET libraries/:id` every 3s while any
      source is `syncing`.
    - `app/pages/helpinator/widgets/[id].vue`: replace the portfolio select
      with a multi-select of libraries, a default-library select limited to
      the chosen ones, and the default-section select shown only when the
      default is a portfolio. Rebinding warning covers both fields.
    - `app/pages/helpinator/conversations/[id].vue`: show searches and
      pages loaded per assistant turn.
    - `app/utils/helpinator-types.ts`: library/source/page types, widget
      fields.
12. **Sidebar/list pages**: widgets index shows the default library name
    instead of the portfolio name.
13. **README / PLAN**: README "Libraries" section (what a website library
    does, crawl rules, the read-only rule, re-embed), env note for pgvector.
14. **Tests** (`tests/api/`, fake AI incl. fake embeddings)
    - `libraries.test.ts`: CRUD, delete refused while referenced (409),
      default must be in list, cross-org 404.
    - `crawl.test.ts`: unit-level with an in-process fixture server
      (`node:http` on a random port serving 5 linked pages incl. one
      off-path, one off-host, one PDF): discovery respects path/host/
      max_pages, extraction yields markdown, hash skip on second run,
      vanished page deleted, a second source skips URLs the first owns,
      superseded run stops writing.
    - `search.test.ts`: hits limited to the widget's libraries; a chunk in
      another org's/library's page never appears; `load_page` with a ref from
      a non-allowed library → "unknown ref".
    - `isolation.test.ts` update: tools are exactly `['search',
      'load_page']`, neither schema has `library`/`portfolio`; prompt has no
      other library's name.
    - `widget-public.test.ts` update: auto-search part present and
      non-cached; `pages_loaded`/`searches` recorded.

### D. Devops / host

1. `go-apps/docker-compose.yml`: `image: pgvector/pgvector:pg18` (comment:
   prod is Railway's pgvector template). Same for the nuxtinator dev test DB
   docs (`scripts/setup-test-db.sh` / README) so `CREATE EXTENSION` works in
   tests.
2. `go-apps/layers.ts` bump helpinator/context/ai refs when published;
   `bun run setup`.
3. Env: nothing new. Admin → AI: pick the host embedding model (recommend
   `openai/text-embedding-3-small`); orgs override on their AI settings page
   only if they need to.
4. Seed the D.T library by hand in the admin: four sources as listed.

### Order of work

1. A1–A8 (embed, chunker, vector helpers, fallback) → A9–A12 (setting, admin).
2. B1–B4 (chunks, indexer, save hook) → B5–B8.
3. C1–C5 (tables, libraries util, crawler, search) → C6–C9 (bot + routes) →
   C10–C12 (admin UI) → C13–C14.
4. D, then seed and test with the real site; tune caps.
