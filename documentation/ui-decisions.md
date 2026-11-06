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

- **Settings are rows grouped into a few cards, not one card per setting.** Each row shows a label, the current value and an action (see `SettingsGroup` / `SettingsRow`). A card holding a single button or field read as sparse and made the page long.
- **Forms stay closed until the user acts.** A row's Change button opens its form under the row, with Save and Cancel; one row is open at a time. The open panel sits on `bg-(--ui-bg-elevated)` with rounded corners, so it reads as revealed content rather than part of the card. Destructive actions (delete account) open the same way, behind an outlined error button.
- **A page or tab whose settings are edited together may be one open form with a save bar instead of rows.** `SaveBar` sits at the end of the form and sticks to the bottom of the screen, so Save is always in reach on a long page; Save is disabled until something changes and Discard appears beside it. `useUnsavedGuard` confirms before a tab switch, a navigation or closing the browser tab drops unsaved edits.
  - Rows alone were rejected for these pages: settings that belong together (a site's details, a form's questions with a live preview) had to be opened, saved and closed one at a time, and a preview can't show several unsaved changes at once.
  - Per-section Save buttons on an open form were rejected: saving one section reloaded the page's data and dropped unsaved edits in the others, and it wasn't clear which button saved what.
  - The guard's dialog offers Discard or Cancel (stay) only; saving stays on the bar, so there is one way to save. Tabs on a guarded page use `activation-mode="manual"`: closing the dialog returns focus to the clicked tab, and automatic activation reselected it and reopened the dialog.

## Teams

- **Limiting a container to teams is one field, "Who can see it", in the container's own create and settings forms** (`TeamAccessField`): everyone in the org, or only certain teams, then a multi-select of teams. It offers the caller's own teams (every team for holders of `<app>.all_teams`) and keeps teams already on the container listed even when the caller can't pick them, so a save never silently drops one. It renders nothing unless the org runs teams and the caller has a team to pick (or the container is already limited), so orgs without teams never see it.
  - A separate share dialog, like personal apps' `ShareDialog`, was rejected: team restriction is a property of the container that its editors change alongside its name, not a list of people.
- **"Show all teams" is a switch in the app's own chrome** (`ShowAllTeamsToggle`), off by default and remembered per app in a cookie the server reads, so admins get the same tidy view as everyone else until they ask for more. It hides itself unless the org runs teams or it's already on.
- **Group management is one component** (`GroupsManager`) behind `/admin/groups`, `/@<slug>/settings/groups` and the org's Groups panel on `/admin/orgs`, so the three stay alike. The org page carries the audiences/teams switch next to the list; switching to teams asks first, because members start seeing each other.
- **An org's groups run as teams by default; host groups as audiences.** Orgs mostly want groups to organise people who already work together, and nothing is limited to a team until someone picks one. Host groups gate personal apps across the whole instance, where members needn't know about each other, and existing deployments already relied on audiences there.
- **Adding a group opens a modal** with its name and its members, from an "Add group" button beside the page heading. A name field inline next to the button was rejected: it cluttered the page and left members to a second step.
- **A group has an avatar: an uploaded image, else an icon, else its initials** (`GroupAvatar`). Every list or picker that shows a group shows its avatar beside the name, so a group reads the same everywhere; menu and select items take `avatar: groupAvatarProps(group)` instead of a generic team icon. The image and icon are set in the same modal as the name: Add group opens it empty, the row's Edit opens it filled. An inline rename on the row was replaced by that modal so the avatar and name are edited together.

## Views

- **A view holds tabs, shown in the header row next to its name.** The view keeps the record type, sharing, a base filter and any hand-picked records; each tab picks its own layout (board, list or table), grouping, card fields, sort and an extra filter ANDed with the view's. "My tasks" is one view with "My open tasks", "By status" and so on as tabs, so one share covers all of them.
  - A separate container object with its own name ("collection", "workspace", "tracker", "page") was rejected: none fit every record type and layout, and people already make views, so tabs inside a view add no new thing to learn.
- **Filters are built in a modal behind a "Filter · N" button** in the tab's toolbar: rules and groups one level deep, each matching all or any. A tab's builder shows the view's base filter read-only above it, since the tab can only narrow it. Edits save to the tab for everyone; people who can only view see the builder read-only.
  - Inline filter chips in the toolbar were rejected: they couldn't express OR, and they mixed personal and saved filters in one row.
  - Readable chips under the tabs were considered and left out for now; the count on the button is the only on-page sign of a filter.
- **The list layout is one row per record with a done checkbox** on types with exactly one closed status; unticking returns the record to its status field's default. Rows drag into a manual order per tab and, when grouped, between sections with the board's move-or-add rules.
- **Who can open a view is set in its Share popover, not shown beside its name.** The popover holds the "Who can see it" checklist (everyone, teams, or ticking nothing for only the owner) and the people it's shared with. The new-view modal has the same checklist. A Private/Shared badge in the header was dropped: it repeated what Share shows and couldn't say which teams.
- **Any board tab can have custom columns, not only a view of hand-picked records.** On a view that shows every matching record, cards nobody has placed sit in a leading "No column" lane, and a new custom-column tab starts with only that lane so people add the columns they want. Moving a card there only moves it on that tab, never the record.
  - Dropping unplaced cards into the first column was rejected: every new record would quietly land in "To do", and sorted cards couldn't be told from ones nobody had looked at.
  - Starting with To do / Doing / Done was rejected for these tabs: a tab beside a status board is for sorting cards your own way, and three stock columns had to be renamed or removed first. A hand-picked view's boards keep them, since its cards always need a column.
- **The new-view and new-tab modals pick the layout and the column mode from cards** with an icon and a name each, in a wider modal with a header and footer. Inline radio buttons made the modals read as one dense block where the choices that shape the view looked like minor options.
- **A board or list grouped by status has no "No status" column.** Every record type has a status and a record without a stored one reads as the default, so the column could only ever be empty; dropping a card there is refused. New boards start grouped by status.
