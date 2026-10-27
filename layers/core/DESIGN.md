# Nuxtinator UI rules

For anyone building pages in a nuxtinator host or layer. Read this before any UI work and follow it. In a consumer project it sits at `_layers/core/DESIGN.md`.

The reasoning behind each rule, and what was tried and rejected, is in `documentation/ui-decisions.md` in the nuxtinator repo. Change a rule there and here together.

## Use the core components

Reach for these before writing your own markup. They hold the styling, so a fix in core reaches every page.

| Need | Use |
|---|---|
| Help or explanation for a field or section | `<InfoTip text="…" />` |
| Sidebar | `<SidebarPanel>` with `<SidebarNav :items>` inside |
| Settings page | `<SettingsGroup title>` cards of `<SettingsRow label value>` rows; `useSettingsRow(id)` keeps one row open at a time |
| Page or tab edited as one form | `<SaveBar :dirty :saving @save @discard>` at the end of the form, with `useUnsavedGuard(dirty, discard)` |
| Confirm before a destructive action | `if (!await confirmAction({ title, confirmLabel })) return` with `const confirmAction = useConfirm()`; or `<ConfirmModal v-model:open @confirm :loading>` when the modal should stay open while the work runs |
| Labelled divider | `<USeparator label="…">` |
| Theme or language picker | `<ThemeToggle>`, `<LocaleSwitcher>` |

## Keep pages uncluttered

- **Explanations go behind an (i) icon, not on the page.** Put `<InfoTip>` next to the label or heading. On a `UFormField`, use the label slot: `<template #label>Label <InfoTip text="…" /></template>`. For longer help, put `<p>` paragraphs inside `<InfoTip>`.
- No full-sentence `description` under each field, and no intro paragraph under page or section headings.
- Show on the page only what the user needs right now: short labels, validation errors, and a short note on why a control is disabled (`help="Set by the platform operator."`).
- No subtitle that repeats the page title.

## Settings pages

Use one of two patterns per page or tab.

**Rows**, for settings that each stand on their own:

- Group settings as rows in a few `SettingsGroup` cards, not one card per setting. Each row shows label, current value and an action.
- Forms stay closed until the user acts: a row's Change button opens its form under the row (the `panel` slot with `open`), with Save and Cancel. One row open at a time.

**One form with a save bar**, for settings edited together (a whole tab, or anything with a live preview):

- The fields are open on the page, grouped in a few cards, with no per-section Save buttons.
- End the form with `<SaveBar>`. Save stays disabled until something changes; Discard changes appears beside it once it has.
- Call `useUnsavedGuard(dirty, discard)` so switching tabs, leaving the page or closing the browser tab asks before dropping unsaved edits. Tabs on the page need `activation-mode="manual"`.
- A toggle that takes effect on its own (a switch) may still save at once; keep it out of `dirty`.

Either way, destructive actions open behind an outlined error button and confirm with `ConfirmModal`.

## Dialogs and feedback

- Never use `alert()`, `confirm()` or `prompt()`. Confirm with `useConfirm()` / `ConfirmModal`; report success and errors with `useToast()`.

## Colors and surfaces

- Use theme tokens, never raw grays: `text-(--ui-text-muted)`, `text-(--ui-text-dimmed)`, `border-(--ui-border)`, `bg-(--ui-bg-elevated)`. Raw `neutral-*` / `slate-*` classes break in one of the two modes.
- Headers and sidebars use `bg-(--chrome-bg)` (`SidebarPanel` already does).
- Cards: plain `<UCard>` — core sets its fill and outline; don't restyle it. A hand-built card-like tile uses `bg-(--ui-bg-elevated)/50 hover:bg-(--ui-bg-elevated) dark:border-(--ui-border-accented)`.
- A layer never overrides theme tokens. A host may, with plain `:root { … }` / `.dark { … }` rules in its own CSS.

## Nuxt UI gotchas

- Never put an option with `value: ''` in a `USelect` / `USelectMenu` `:items`: it throws and the menu opens empty. Express "nothing selected" with the `placeholder` prop.
