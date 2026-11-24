# `<feedback-web-component>`

A single-file Vue IIFE web component. One `<script>` tag on any site drops a feedback capture widget in the corner; every submission lands as a Kanban card in a central project.

This is the first widget built on the **layer-served bundle** pattern in this monorepo — a layer ships its own built web-component and Nuxt serves it from the layer's `public/`. If you're adding a second web component, this folder is the reference implementation.

![Feedback Web Component Architecture](docs/feedback-web-component-architecture.svg)

## The big picture

```
layers/apps/feedback/                           ← the feedback layer (extended by any host)
├── public/
│   └── js/feedback-web-component.iife.js       ← build output (committed; Nuxt serves it at /js/…)
├── app/plugins/feedback-widget.client.ts       ← injects <script> + <feedback-web-component> per page
└── embeddables/
    └── feedback-web-component/                 ← you are here (self-contained sub-project)
        ├── src/                                ← Vue source (entry.js, stores, composables, profiles)
        ├── vite.config.js                      ← builds to ../../public/js/ (the layer's own public dir)
        └── index.html                          ← local dev tester (loads bundle from a running host's /js URL)
```

Consumers anywhere on the internet embed the widget with a single `<script src="https://<your-nuxt-host>/js/feedback-web-component.iife.js">`. See [docs/EMBEDDING.md](docs/EMBEDDING.md) for the full consumer-facing guide.

## Why this pattern

**Monorepo sub-project.** Each web component is a self-contained folder (own `package.json`, own `vite.config.js`, own `node_modules`) nested inside the Nuxt app that serves it. Source + build config live next to the thing that hosts them, but the build toolchain stays isolated.

**Self-hosted, layer-served.** The Vite config's `outDir` points at the feedback **layer's own** `public/js/` folder, and the built bundle is committed with the layer. Nuxt serves every extended layer's `public/` at the site root, so the bundle is available at `https://<host>/js/feedback-web-component.iife.js` on **any** host that loads the layer — the monorepo dev host and every scaffolded consumer app alike — with no host-side build step or copy. Rebuild with `bun run build:widgets` from the layer root and commit the result whenever the widget source changes. No S3, no third-party CDN, no separate deploy pipeline.

**Module federation via script tag.** Every external site that embeds the widget loads the same live URL. When you push a change to the monorepo, every consumer picks up the new bundle on the next cache revalidation. One source of truth, zero-touch propagation — the core benefit other teams reach for Webpack Module Federation or React Server Components to get, achieved with a `<script>` tag + custom element.

**Single-file IIFE, CSS inlined.** One file on disk, one URL for consumers to embed, no CSS/JS version skew possible.

## Dev workflow

```bash
# from this folder
bun install
bun run build           # builds to ../../public/js/feedback-web-component.iife.js (the layer's public dir)
bun run build:watch     # rebuilds on every src/ change
```

Or, from the layer root, `bun run build:widgets` runs the two commands above for you.

**One build output:** `../../public/js/feedback-web-component.iife.js` — the feedback layer's own `public/js/` bundle. It's committed with the layer and served by Nuxt at `/js/feedback-web-component.iife.js` on any host that loads the layer (see *Why this pattern* above). There's no separate tester copy.

Then open [index.html](index.html) in a browser — a self-contained tester that loads the bundle from a **running host's** `/js/` URL: paste the host's base URL (e.g. `http://localhost:2080`) and a real project UUID into the form, and it renders `<feedback-web-component>` exactly the way a customer site embeds it.

## Inside the bundle

- **`src/entry.js`** — registers the `<feedback-web-component>` custom element, injects the `.feedback-widget-slot` wrapper CSS into `<head>` on load.
- **`src/ProfileLoader.vue`** — root component that reads the `profile-config` attribute (JSON string) and mounts the chosen profile.
- **`src/app-profiles/`** — one Vue component per UI profile. `chat-bubble.vue` is the default floating-bubble UI.
- **`src/stores/authStore.js`** — Pinia store for login state. `localStorage`-mirrored so sibling instances on the same origin share auth without re-logging-in.
- **`src/composables/`** — `useApi.js` (fetch wrapper + Bearer token), `useFeedback.js` (submission logic, cross-instance token sync).
- **`slot.css`** — `.feedback-widget-slot` positioning rules. Inlined into the JS bundle at build time via `?raw` import.

Architecture diagram: [docs/feedback-web-component-architecture.svg](docs/feedback-web-component-architecture.svg)

## Adding a new web component

Copy this folder, rename, update three things:
1. `package.json` `name` field
2. `vite.config.js` `lib.name` (IIFE global) and `lib.fileName` (output filename)
3. `src/entry.js` `customElements.define('<your-tag>', ...)`

Then wire the build into the layer's [package.json](../../package.json) `build:widgets` script (it `cd`s into each embeddable and runs its build). The dev host's own `build:widgets` chains to the layer's, so `bun run build:widgets` from `dev/` rebuilds every widget before `nuxt build`.

## Where feedback lands

Every submission becomes a card in the Kanban project whose UUID is passed as `projectId`, starting in the `FEEDBACK INBOX` column. Humans triage in the Kanban UI; agents triage via the MCP tools (`feedback_list`, `feedback_load`, `feedback_accept`, `feedback_reject`, `feedback_triage_needed`).

## Hidden-by-default mode

Embedders can pass `"showByDefault": false` in `profile-config` to keep the widget invisible for ordinary visitors. Anyone who loads the host page with `?feedback` in the URL gets the flag persisted to `localStorage["show-feedback-widget"]` and sees the widget from then on. Useful for internal testers, beta cohorts, or customers you've sent a feedback link to. Full details and examples in [docs/EMBEDDING.md](docs/EMBEDDING.md).

## Testing mode

For sites being tested, the widget can stand out: a labelled "Give feedback" button set in from the corner, and on a visitor's first visit a note above it ("This site is being tested. Spot a problem or have an idea? Tell us here.") that stays dismissed once closed or once the panel is opened. The panel never opens by itself.

Two switches turn it on:

- **Per project:** the Testing mode switch in the project's settings on the Feedback board. `GET /api/v1/project/:id` returns it as `widget_mode` (`standard` or `testing`), so every site embedding that project follows it without a redeploy.
- **Per site:** `"mode": "testing"` or `"mode": "standard"` in `profile-config` sets the mode for that embed and wins over the project switch, e.g. testing on a staging site and standard on production when both send to one project. Nuxtinator hosts set it with `NUXT_PUBLIC_FEEDBACK_MODE`; leave it empty to follow the project.

The widget remembers the last mode it saw for a project (`localStorage["fw-mode:<projectId>"]`), so the button keeps its shape while the project loads.

## See also

- **[docs/EMBEDDING.md](docs/EMBEDDING.md)** — how external sites consume the widget via URL
- **[index.html](index.html)** — local dev tester (runs after `bun run build`)
- **[docs/feedback-web-component-architecture.svg](docs/feedback-web-component-architecture.svg)** — runtime architecture diagram
