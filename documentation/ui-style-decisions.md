# UI style decisions

Style choices that apply to every page in the nuxtinator layers (colors, tokens, surfaces, containers, chrome, help text, and the page patterns any screen reuses), with the reasoning behind each and what was rejected. Check this before changing any of them; add an entry when a new decision is made.

Decisions about how one feature works (views, records, teams, email admin) go in [ux-feature-decisions.md](ux-feature-decisions.md). The test: if the decision would hold on a page that has nothing to do with the feature where it came up, it belongs here.

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
- **`--ui-primary` and `--ui-text-inverted` are overridden as a pair, per mode.** Solid buttons, switches and `bg-inverted` surfaces draw `--ui-text-inverted` on them. A host that lightened its brand color for dark mode but set the text color once (white, for the light-mode brand) shipped dark-mode buttons at about 3:1; setting both tokens in `:root` and `.dark` fixed it.
- **Prefer a named variable over editing a shared Nuxt UI token** when only some surfaces should change (see `--chrome-bg`). Shared tokens like `--ui-bg-elevated` and `--ui-border` are used by many Nuxt UI components.

## Surfaces

- **Cards have a subtle fill.** `UCard` defaults to Nuxt UI's `subtle` variant (`bg-elevated/50` + ring) via `app.config`. Card-like tiles built by hand use `bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated)`. Transparent cards with only a border blended into the page.
- **Card outlines are brighter in dark mode only** (neutral-700, i.e. `--ui-border-accented`): `dark:ring-accented` on `UCard`, `dark:border-(--ui-border-accented)` on hand-built tiles.
- **Content sits in cards, not loose on the page background.** Each list, form section or group of controls is a `UCard` with its title in `#header`, rows or fields in the body, and its main action ("Add …") in `#footer`.
  - Sections separated only by headings, whitespace and divider lines were rejected: on a wide screen the inputs and text read as floating in the middle of the page, with nothing showing what belonged together.
- **A row shows one action button; the rest go in a ⋯ menu.** The value comes first (a time, a name), then usually Change; pause, export and the like sit in a `UDropdownMenu`, destructive items last in their own group in the error color.
  - Four outline buttons per row (Change, Pause, Remove, Add to calendar) were rejected: every row looked like a toolbar, and Remove sat next to everyday actions.
  - A ⋯ menu on the card header directly above a row's ⋯ menu was rejected: two identical buttons stacked, with no way to tell which acted on what. A card-level action goes in the footer instead.
- **Finished items sort last**, with a neutral badge and a muted title, so active work leads.
- **Labelled dividers use `<USeparator label="…">`**, never a label `<span>` painted with a background over a line. A painted span only matches one surface, so it shows as a box on filled cards.
- **The global border stays at Nuxt UI's default** (neutral-800 in dark). Brightening `--ui-border` globally was tried and rejected: header, sidebar and divider lines became too prominent.

## Chrome (headers, sidebars, rail)

- **Headers and sidebars use `bg-(--chrome-bg)`**: `--ui-bg-elevated` in light mode; in dark mode a midpoint between neutral-800 and neutral-900, one tone darker than elevated and slightly lighter than the page. Applies to the top bars in `layouts/default.vue` and `layouts/admin.vue`, `AppSidebar` and `SidebarPanel`.
- **The app rail** stays `bg-neutral-200 dark:bg-neutral-950`. Collapsed it is `w-14` with names on hover; expanded it is `w-56` with names next to the icons, and it pushes the content over rather than covering it. Icons keep the same x position in both states. Its dividers (plain and labelled) use `border-accented` in light mode and `border-default` in dark, and its current and hovered items are `--ui-bg-elevated` (hover at 50%) in light mode and `--ui-bg-accented` in dark: the light fill is the same gray as the default border and `--ui-bg-accented`, which left both invisible. White was tried for the light highlight and was too glaring. `OrgSettingsRailLink` uses the same highlight.
- **The theme toggle sits in the top bar** between the notification bell and the profile icon, in both the desktop and mobile headers (`<ThemeToggle size="sm" />`).

## Help text

- **Explanations go behind an (i) icon, not on the page.** Put `<InfoTip text="…" />` (core) next to the label or heading; it opens the text in a click popover, so it works on touch. For longer help, put `<p>` paragraphs in its default slot. On a `UFormField`, use the `#label` slot: `<template #label>Label <InfoTip text="…" /></template>`.
  - Full-sentence `description`s under every field, and intro paragraphs under page and section headings, were rejected: the page turned into a wall of text and the controls got lost.
- **Keep on the page only what the user needs right now**: a short note explaining why a control is disabled (e.g. `help="Set by the platform operator."`), validation errors, and labels. Keep labels short; move the detail into the InfoTip.
- **Don't add a subtitle that repeats the page title.**
- InfoTip sits at `vertical-align: -0.2em`, which centres the icon on the label's capital letters; `align-middle` made it sit low.

## Timestamps

- **Times show as short relative text, with the exact time one step away** (`<RelativeTime>`, core). "3h ago", "2d ago", then the date. Hovering shows the full date and time with seconds and time zone. Tapping or clicking a timestamp switches every timestamp on the page to exact times ("Nov 11, 2:32:07 PM") until the next reload, and tapping again switches back. Inside a clickable row (a conversation list, the notification menu) it is hover-only, so a tap still opens the row.
  - The date alone, with no way to reach the time, was rejected: an activity feed couldn't show which of two events on the same day came first, or how far apart they were.
  - A hover tooltip alone was rejected: touch screens never show it.
  - Always showing the exact time was rejected: it is wider and slower to scan than "3h ago", and the rough age is usually all anyone needs.
  - Remembering the exact-times switch for each viewer was rejected: it's a diagnostic switch, so it starts off on every page load.
  - A relative-time helper in each layer was rejected: the copies drift apart ("5m" in one place, "5m ago" in another) and a fix in one never reaches the others.

## Settings pages

- **Settings are rows grouped into a few cards, not one card per setting.** Each row shows a label, the current value and an action (see `SettingsGroup` / `SettingsRow`). A card holding a single button or field read as sparse and made the page long.
- **Forms stay closed until the user acts.** A row's Change button opens its form under the row, with Save and Cancel; one row is open at a time. The open panel sits on `bg-(--ui-bg-elevated)` with rounded corners, so it reads as revealed content rather than part of the card. Destructive actions (delete account) open the same way, behind an outlined error button.
- **A page or tab whose settings are edited together may be one open form with a save bar instead of rows.** `SaveBar` sits at the end of the form and sticks to the bottom of the screen, so Save is always in reach on a long page; Save is disabled until something changes and Discard appears beside it. `useUnsavedGuard` confirms before a tab switch, a navigation or closing the browser tab drops unsaved edits.
  - Rows alone were rejected for these pages: settings that belong together (a site's details, a form's questions with a live preview) had to be opened, saved and closed one at a time, and a preview can't show several unsaved changes at once.
  - Per-section Save buttons on an open form were rejected: saving one section reloaded the page's data and dropped unsaved edits in the others, and it wasn't clear which button saved what.
  - The guard's dialog offers Discard or Cancel (stay) only; saving stays on the bar, so there is one way to save. Tabs on a guarded page use `activation-mode="manual"`: closing the dialog returns focus to the clicked tab, and automatic activation reselected it and reopened the dialog.

## Icons and avatars

- **An icon is picked from a square button showing the icon** (`IconPicker`), which opens a searchable grid. A full-width select-style trigger showing the icon's name was rejected: it read as a text field, and the name (`i-lucide-mail`) means nothing to the person picking.
- **People on cards and list rows are avatars without names**: the image, else two initials (first and last name, or the first two letters of a single name), the same initials a member's own avatar shows. The name is the avatar's tooltip. Avatar plus full name was rejected as the widest thing on the card, more so once a task can have several assignees. One-letter initials were rejected: without the name beside them they can't tell Alice from Adam.
- **A person without an avatar image gets their initials on a color of their own**, one of twelve soft hues (`USER_AVATAR_COLORS` in core, shown on `/kitchen`), so avatars that carry no name still differ at a glance. An uploaded image replaces it. The color is worked out from the user's id, the same everywhere, and nothing is stored. Saving a random color on each user was rejected: it would put a default in the database, and changing the palette would need a backfill. Saturated fills with white initials were rejected as too loud beside the app's subtle badges.
