# `<helpinator-widget>`

A single-file Vue IIFE web component: the floating help chat. It follows the
same layer-served bundle pattern as the feedback widget
(`layers/apps/feedback/embeddables/feedback-web-component`).

```bash
bun install
bun run build        # → ../../public/js/helpinator-widget.iife.js (commit it)
bun run build:watch
```

## Files

- `src/entry.js` registers the custom element.
- `src/HelpinatorWidget.ce.vue` is the UI. Its styles are inlined into the
  Shadow DOM, and the CSS variables it supports are documented at the top of
  the `<style>` block.
- `src/api.js` is the public API client. It includes a small SSE reader for
  streamed turns (a POST can't use `EventSource`).
- `src/storage.js` holds the `localStorage` cache, keyed `helpinator:<widgetId>`.
  It's a display copy only; the server transcript wins on restore.

## Attributes

- `host`: the Nuxt host's origin. Defaults to the page's own origin.
- `widget-id`: the widget's UUID.
- `open`: start with the chat open.

Everything else comes from the widget's config on the server. See the layer
[README](../../README.md) for embedding and per-site styling.
