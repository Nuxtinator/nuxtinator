# @nuxtinator/helpinator

An embeddable AI help chat. A site adds one `<script>` tag. Visitors then chat
with a bot that answers from the widget's **libraries** — crawled websites
and/or context portfolios, searched by vector similarity — through the ai
layer's OpenRouter backend. Staff get a read-only conversation log. A visitor
who still needs help is handed off to the shared inbox.

Requires `@nuxtinator/context` and `@nuxtinator/ai`. `@nuxtinator/inbox`
(which needs `@nuxtinator/crm`) is **optional**. Without it, the widget hides
"Still need help?".

## Features

- **Libraries.** Managed under `/helpinator/libraries`, shared by every widget
  in the org. Two kinds:
  - **website** — a list of URL entries. Each entry crawls its page plus the
    same-site pages it links to (one hop, optionally only under the entry's
    path, capped per entry), extracts the main content with a readability
    parser, stores it as markdown and indexes it for search. Content React
    streams in after the shell (Next.js Suspense) is swapped in first, and
    data tables become one labelled line per row. No JavaScript runs, so
    client-rendered pages still come back empty. Per-entry
    **Re-crawl**, per-library **Sync all**, a page viewer, and pruning of
    junk pages. Pages are read-only: a re-crawl replaces them (unchanged pages
    are not re-embedded).
  - **portfolio** — a pointer at a context portfolio. Nothing is copied; the
    bot reads sections live and searches the context layer's own index. This
    is where corrections and additions to crawled content belong.
- **Widgets.** One per site, managed under `/helpinator/widgets`. Each widget
  has:
  - a list of libraries it may use, one of them the default (its page index is
    part of every chat), and, for a portfolio default, a preloaded section
  - an allowed-origins list
  - a daily message cap
  - optional extra instructions
  - up to six suggested questions, shown as clickable buttons under the
    greeting until the visitor sends a message
  - appearance (colour, position, title, greeting, placeholder, handoff prompt)
- **Embed helper.** The widget page shows the snippet to paste, a CSS-variables
  block to match the site's look, and a live preview of the saved widget.
- **Chat.**
  - Replies stream over SSE.
  - Replies render as sanitized Markdown, in the visitor's language.
  - Every visitor message is searched across the widget's libraries and the
    best hits are injected into the prompt. The bot also has a `search` tool
    for rephrased follow-ups and a `load_page` tool to read a page or section
    in full.
  - The server holds the transcript. The browser caches it in `localStorage`
    so a refresh doesn't lose the chat.
- **Handoff.** "Still need help?" asks for an email and creates an **open,
  unassigned** inbox conversation (`source: 'helpinator'`) with the transcript
  as its first message. The visitor gets the inbox auto-ack plus a copy of the
  transcript. This happens at most once per conversation.
- **Log.** Read-only, filterable per widget and by handoff state. Each reply
  lists the searches it ran and the pages it read. Each conversation shows its page URL,
  origin and user agent. Raw IPs are never stored.

## Setup

1. Add the layer to the host (`layers.ts`), after `context` and `ai`. The
   database needs the **pgvector** extension (Railway's pgvector template, the
   `pgvector/pgvector:pg18` image, or `CREATE EXTENSION vector;` run by a
   superuser before the first boot — the migration creates it when it can).
2. In AI settings, enable a chat model and pick an **embedding model**. The
   chat feature is **Helpinator — help chat** (`helpinator.chat`), one model
   for every widget in an org. Changing the embedding model later invalidates
   every index until it is re-embedded (a button on the same page does that).
3. Go to `/helpinator/libraries` → **New library**. For a website library add
   the URLs to crawl; for a portfolio library pick a portfolio that holds
   **public information only** (see Security).
4. Go to `/helpinator/widgets` → **New widget**. Pick its libraries and the
   default one, and add the site's origin, e.g. `https://www.example.org`.
5. Paste the snippet shown on the widget page into the site:

   ```html
   <script src="https://<host>/js/helpinator-widget.iife.js" defer></script>
   <helpinator-widget host="https://<host>" widget-id="<uuid>"></helpinator-widget>
   ```

   Add the `open` attribute to start with the chat open.

## Per-site styling

The server-configured colour is the default. The embedding site can override
any of these custom properties on the element (they inherit through the Shadow
DOM):

| Variable | Default |
|---|---|
| `--helpinator-primary` | the widget's colour |
| `--helpinator-on-primary` | `#fff` |
| `--helpinator-bg` / `--helpinator-text` / `--helpinator-muted` | white / near-black / grey |
| `--helpinator-border` / `--helpinator-bot-bubble` | light greys |
| `--helpinator-font` | system UI stack |
| `--helpinator-radius` | `14px` |
| `--helpinator-offset-x` / `--helpinator-offset-y` | `20px` |
| `--helpinator-width` / `--helpinator-height` | `370px` / `560px` |
| `--helpinator-z-index` | `2147483000` |

For deeper overrides, use `::part(launcher | panel | header | message |
user-message | bot-message | composer | send | form | banner)`.

## Security

- **Library isolation is enforced in code, not in the prompt.**
  - The tools are `search({ query })` and `load_page({ ref })`. Neither takes a
    library or portfolio argument; a ref that does not resolve inside the
    widget's libraries is unknown.
  - Every query filters on the conversation's snapshot of its widget's
    library ids.
  - The prompt indexes only the default library; search hits come only from
    the allowed libraries.
  - Other orgs are unreachable: the widget id resolves to its org, and the whole
    turn runs in that org's RLS-scoped transaction.
  - Rebinding a widget to other libraries ends its open conversations.
  - Covered by `tests/api/isolation.test.ts` and `tests/api/search.test.ts`.
- **Everything in the widget's libraries is extractable**, and so are the
  widget's extra instructions. Prompt injection can make the bot reveal
  anything it can read. Keep helpinator portfolios public-only; crawled
  sites are public by nature.
- **Origin checks only stop browsers.** The real bound on AI spend is:
  - rate limits keyed on an HMAC of the client IP (8 messages/min and 60/hour
    per client, 5 handoffs/hour)
  - the per-widget daily cap (visitor messages per rolling 24h)
  - a 50-message cap per conversation
  - a 2,000-character limit per message
- The session token is random and stored only as a sha256. A token is bound to
  one widget.

## Permissions

- `helpinator.access`: open the app and read the conversation log.
- `helpinator.manage`: configure widgets.

Default grants: `admin` gets both, `member` gets neither.

## Widget bundle

The source lives in [embeddables/helpinator-widget](embeddables/helpinator-widget/).
It builds into this layer's `public/js/`, which is committed and served by any
host that loads the layer. Rebuild with `bun run build:widgets` from the layer
root after changing the widget source.

## Tests

`bun run test -- --project helpinator` from `dev/`. The tests run against the
ai layer's VITEST fake, so no model key is needed.
