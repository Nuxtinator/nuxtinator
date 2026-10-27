# UI decisions

Styling and UI choices for the nuxtinator layers, with the reasoning behind each. Check this before changing colors, tokens, surfaces or chrome; add an entry when a new decision is made.

The rules themselves, as developers in this repo and in consumer projects should follow them, live in [layers/core/DESIGN.md](../layers/core/DESIGN.md), which ships with core. This file keeps the reasoning and the rejected alternatives. When a decision is made or reversed, update both.

Theme tokens live in [layers/core/app/assets/css/main.css](../layers/core/app/assets/css/main.css) and [layers/core/app/app.config.ts](../layers/core/app/app.config.ts).

## Color palette

- **Light mode uses slate grays; dark mode uses neutral (charcoal) grays.** `app.config` sets `neutral: 'slate'`; the `.dark` block in `main.css` remaps `--ui-color-neutral-*` to Tailwind's neutral scale (`var(--color-old-neutral-*)`).
  - Pure neutral in light mode was tried and rejected: slate reads better in light mode. Slate-blue in dark mode was rejected in favor of charcoal.
  - Consequence: a host's `ui.colors.neutral` choice only takes effect in light mode.
- **First-paint background matches `--ui-bg`**: `#fff` / `#171717` in the inline head style in [layers/core/nuxt.config.ts](../layers/core/nuxt.config.ts). Update it whenever the dark background changes, or dark-mode loads flash the old color.

## Text

- **Text tokens are one step stronger than Nuxt UI's defaults, evenly in both modes**, so readability improves without collapsing the hierarchy.

  | Token | Light | Dark |
  |---|---|---|
  | `--ui-text-highlighted` | neutral-950 | `#fff` |
  | `--ui-text` | neutral-800 | neutral-100 |
  | `--ui-text-toned` | neutral-700 | neutral-200 |
  | `--ui-text-muted` | neutral-600 | neutral-300 |
  | `--ui-text-dimmed` | neutral-500 | neutral-400 |

  Darkening light-mode text two steps (body neutral-900) was rejected: body text became indistinguishable from headings.

## Overridability

- **Core's token overrides are unlayered and use plain `:root` / `.dark` selectors.** A host overrides any of them with an ordinary `:root { … }` or `.dark { … }` rule in its own CSS (host CSS loads after layer CSS). Don't use higher-specificity selectors like `:root:not(.dark)` — they silently beat host overrides.
- **Prefer a named variable over editing a shared Nuxt UI token** when only some surfaces should change (see `--chrome-bg`). Shared tokens like `--ui-bg-elevated` and `--ui-border` are used by many Nuxt UI components.

## Surfaces

- **Cards have a subtle fill.** `UCard` defaults to Nuxt UI's `subtle` variant (`bg-elevated/50` + ring) via `app.config`. Card-like tiles built by hand use `bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated)`. Transparent cards with only a border blended into the page.
- **Card outlines are brighter in dark mode only** (neutral-700, i.e. `--ui-border-accented`): `dark:ring-accented` on `UCard`, `dark:border-(--ui-border-accented)` on hand-built tiles.
- **Labelled dividers use `<USeparator label="…">`**, never a label `<span>` painted with a background over a line. A painted span only matches one surface, so it shows as a box on filled cards.
- **The global border stays at Nuxt UI's default** (neutral-800 in dark). Brightening `--ui-border` globally was tried and rejected: header, sidebar and divider lines became too prominent.

## Chrome (headers, sidebars, rail)

- **Headers and sidebars use `bg-(--chrome-bg)`**: `--ui-bg-elevated` in light mode; in dark mode a midpoint between neutral-800 and neutral-900, one tone darker than elevated and slightly lighter than the page. Applies to the top bars in `layouts/default.vue` and `layouts/admin.vue`, `AppSidebar` and `SidebarPanel`.
- **The app rail** stays `bg-neutral-200 dark:bg-neutral-950`. Collapsed it is `w-14` with names on hover; expanded it is `w-56` with names next to the icons, and it pushes the content over rather than covering it. Icons keep the same x position in both states.
- **Personal apps sit after org apps.** The collapsed rail separates them with the same plain divider it uses under the home icon (it's too narrow for a label); the expanded rail uses `<USeparator label="Personal">`; the launcher popover uses `<USeparator label="Personal">`; dashboards use a "Personal" heading. On a personal app's pages the rail and org switcher keep showing the last active org, so leaving the app returns to it.
- **Leaving admin**: the admin sidebar (desktop and mobile drawer) opens with a "Back to apps" link above the sections, and the admin header's top-right is a plain × button to the launcher.
- **The theme toggle sits in the top bar** between the notification bell and the profile icon, in both the desktop and mobile headers (`<ThemeToggle size="sm" />`).

## Help text

- **Explanations go behind an (i) icon, not on the page.** Put `<InfoTip text="…" />` (core) next to the label or heading; it opens the text in a click popover, so it works on touch. For longer help, put `<p>` paragraphs in its default slot. On a `UFormField`, use the `#label` slot: `<template #label>Label <InfoTip text="…" /></template>`.
  - Full-sentence `description`s under every field, and intro paragraphs under page and section headings, were rejected: the page turned into a wall of text and the controls got lost.
- **Keep on the page only what the user needs right now**: a short note explaining why a control is disabled (e.g. `help="Set by the platform operator."`), validation errors, and labels. Keep labels short; move the detail into the InfoTip.
- **Don't add a subtitle that repeats the page title.**
- InfoTip sits at `vertical-align: -0.2em`, which centres the icon on the label's capital letters; `align-middle` made it sit low.

## Settings pages

- **Settings are rows grouped into a few cards, not one card per setting.** Each row shows a label, the current value and an action (see `AccountGroup` / `AccountRow`). A card holding a single button or field read as sparse and made the page long.
- **Forms stay closed until the user acts.** A row's Change button opens its form under the row, with Save and Cancel; one row is open at a time. The open panel sits on `bg-(--ui-bg-elevated)` with rounded corners, so it reads as revealed content rather than part of the card. Destructive actions (delete account) open the same way, behind an outlined error button.
