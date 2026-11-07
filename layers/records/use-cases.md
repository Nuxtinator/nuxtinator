# Records and views: personas and use cases

The people and scenarios the records kernel and the views layer are built for, and the rule each scenario sets. Use this to check a change against what the platform is for. Use [README.md](README.md) and [dev.md](dev.md) for how it works.

The goal in one line: **a dynamic PocketBase with views**. Records hold any shape of data an org defines. Views are Trello-style boards, lists and tables over that data. Anyone can make a view and share it, which is where Fibery falls short, since only admins can create views there.

## Personas

| Persona | Who they are | What they need |
|---|---|---|
| **Member** | Anyone in the org | Personal boards for anything ("person 1 todos", "ideas for proj 1", "ways to bake a pizza"), and their own task lists. They must never be flooded with everyone else's items and tasks. |
| **Team lead** | A member running something with others | A view that holds its own cards (onboarding, a set of conversations), shared with a team that can work those cards. |
| **Planning team** | People tracking org-wide work, as the org does today in Fibery | Deliverables that everyone sees. Quarterly milestones, with views over all deliverables. |
| **Stakeholder** | Someone following progress without doing the work | Can open a shared view, read its cards and comment on them. |
| **Org admin / schema manager** | Holds `records.schema.manage` | Creates record types and fields, decides who can see and update each type, and gives a team or everyone access to a whole type. |
| **Contacts team** | CRM users | Contacts are personal data with consent and channels. A board must never widen who can see a person. |
| **AI agent (MCP)** | An agent acting for a user | Creates a missing record type with the fields it needs, then the view, then the records, all in one conversation. |
| **Producer layer** | Another layer writing records (meetings; later feedback) | A stable code-declared type to write into (`task`), so its data shows up in views. |

## Use cases

### 1. Personal boards for anything

A member creates a board such as "ways to bake a pizza" from generic `item` cards, or "person 1 todos" from `task` cards. Nobody else sees those cards until the member shares the view.

- `item` (the freeform card) and `task` (assignee, due date, Open/Done) ship as built-in types that orgs can hide. A generic item covers most needs.
- Members don't hold `view_all` on items or tasks, so they're personal by default. A member sees what they created, what was shared with them, what names them in a people field, and the cards on hand-picked views they can open.
- Status: built.

### 2. My tasks, several ways

A member makes a "My tasks" view with tabs such as "My open tasks" (a list) and a board grouped by status.

- A view owns the record type, the sharing, a base filter and its hand-picked records. Each tab owns its layout (board, list or table), grouping or custom columns, card fields, sort, and a filter that can only narrow the view.
- Filters are a tree of all/any groups nested one level deep. `@me` resolves to whoever is viewing.
- A card added from the view gets the values its filters pin down. On "Assigned to is Me", the new card is assigned to me, so it doesn't drop out of the view.
- Status: built. Still to come: relative dates ("this week", "overdue"), and a personal filter layer for each viewer.

### 3. A team view with its own cards (onboarding, conversations)

A team lead creates an "Onboarding" view of tasks that starts empty, adds cards to it, and shares it with a team. The team sees exactly those cards and nothing else from the system.

- When you create a view, you choose what it holds: **"Its own cards"** (hand-picked) or **"All ‹type›"** (every matching record). The kind can't change afterwards. To get the other kind, make a new view.
- A hand-picked view shares its cards. Can view acts like a view share on each card, and Can edit like an edit share. This applies to people, teams and Everyone, each with their own level. The cards are reachable everywhere, including search, linked records and the record page. The record's Share list shows "Via ‹view›".
- Creating a card on the view needs the type's create permission. Adding an existing record needs share permission on the type and edit access to the record.
- Editors can delete cards created on the view (`created_here`) while no other view holds them. Deleting the view deletes those cards too, after a confirm that counts them.
- Status: built.

### 4. System-wide deliverables and quarterly milestones

The planning team has a `deliverable` type that everyone sees. They work in quarters, and each quarter is a milestone. Each quarter they carry forward the deliverables they still want to do and add new ones. A deliverable can have tasks, though most don't.

- `deliverable` and `milestone` don't ship in code. The org builds them in the schema builder or through MCP. The platform has to handle milestones however an org models them: as a tags field, or as their own record type linked by a connection.
- "System-wide" is set on the type, by giving members `view_all` (the "Everyone" choice when creating the type, or a team row). It isn't set by views. A view over "All deliverables" is then a lens that shows everyone the same cards.
- Boards can group by key_select, multi_select, user, tags and connection fields. What a drag does depends on the field:
  - single-value fields and user fields **move** the card (dragging to someone's column hands the card to them);
  - multi-select, tags and connections **add** the new value and keep the old one, so a deliverable keeps every quarter it passed through.
- Adding a milestone from the card itself is the main way to carry a deliverable forward. The drag is a convenience on top.
- A card can show connected records as names, a count or progress ("3/5 tasks done"). Child records (a deliverable's tasks) are listed in the slideover.
- Status: built. Still to come: selecting several cards and moving them at once (the end-of-quarter bulk move).

### 5. A window onto shared data

Someone creates "Q3 deliverables by status" over all deliverables and shares it with a team.

- A view that shows every matching record is a pure lens and grants nothing. For each viewer, its feed applies the type's read permission, the app's team gate and normal visibility. If people see different cards, that means someone should be given access on the type. It isn't a bug in the view.
- Any member can create and share such a view, including over deliverables. It can't show anything people couldn't already see.
- Status: built. Still to come: links to a record inside a view ("open in view"), "New view from these cards", and featured or official views.

### 6. Giving a team, or everyone, a whole record type

An admin creates `deliverable` and wants everyone, or one team, to see and edit all of it.

- Creating a type asks one question, "Who can see and update them?":
  - Everyone: the member role gets read, create, update and view_all;
  - People involved: no grants are stored;
  - Admins only: every non-admin role is denied.
- The type's settings page has the full Permissions matrix. Below the role rows are **team rows** with the same six actions (read, create, update, delete, share, view_all). Team rows only add to what roles give, and access ends when someone leaves the team. This is the one place teams grant permissions.
- Status: built.

### 7. Sharing views: people, teams, everyone

- A view's visibility is private, teams or org. People can be shared on top whatever the visibility is.
- Can view opens the view. Can edit also changes its tabs and works its cards. Only the owner changes who can see the view, its base filter, and whether it's deleted.
- `/views` has two columns, by audience rather than owner: **Teams**, for anything open to a team or everyone, and **Mine**, for private views, with "Shared with me" underneath. Each column has a "+" that presets the audience.
- Anyone who can see a record can comment on it, so a stakeholder with Can view can ask about a card.
- Status: built.

### 8. Contacts stay private

A sales team shares a pipeline view of contacts.

- Contacts opt out of board-granted visibility (`boardsGrantVisibility: false`). A shared contacts view shares the lens, not the contacts: each person sees the contacts their role already allows.
- Linked records the caller can't open come back with no name, and card counts and progress leave them out.
- Contacts' status is New / Active / Paused / Closed.
- Status: built.

### 9. Every record can be finished or archived

Nobody should have to build a "done" state for each new type.

- Every type has a status field. Types that don't declare one get Open / Done, with Done closing the record. The field can't be hidden. Its options can be renamed, recolored, reordered, added and removed, but at least one open and one closed option must always remain.
- A record with no stored status reads, filters, sorts and groups as the default. New boards start grouped by Status.
- Status: built. Still open: whether lists and tables hide done records by default.

### 10. An agent creates what's missing

A user wants to start recording events, and there's no event type. The agent creates the `event` type with the fields worth tracking, creates a view for it, and the user starts adding data.

- Records MCP has schema tools (`records_create_type`, `records_add_field`, `records_update_field`), gated by `records.schema.manage`. Their descriptions tell the agent to reuse or extend an existing type before creating one.
- Views MCP creates views and tabs, sets filters, and adds and moves cards. OAuth clients need `records.read` to read a view's records and `records.write` to change them through a view.
- A type's default card layout means a view the agent creates looks right straight away.
- Status: built.

### 11. Other layers write into the kernel

The meetings layer creates todos for people. Those todos should be `task` records, so they appear on anyone's task views.

- A producer layer writes a code-declared type and adds its own fields to it (`registerRecordFieldExtension`, for example a meeting link on `task`).
- **Meetings:** `meetings_todos` is dropped, since it has no data. The todos tab and `/meetings/todos` read tasks, and the meetings layer deletes a meeting's tasks along with the meeting. Status: planned, not started (separate repo).
- **Feedback:** its hard-coded kanban moves onto records and views as a later project, once the platform has proven itself on lower-stakes data.
- **go-apps layers** (decisions, showcase and others) keep their own tables for now.

## Deferred

- **AI quick-add**, the way the capture app does it: typing "check the oil in 6 months" creates a task with a due date.
- Selecting several cards and moving them at once.
- Automation rules (a reason "workflows" was dropped as a name: nothing automates yet).
- Timeline, calendar and whiteboard layouts.
- Realtime updates. Views poll.
- Inline cell editing in tables.

## Sources

The decision logs in `~/code/go-all/logs/go-saas/`:
- `2026-08-11-workflows-layer-v1-scoping.md`
- `2026-11-04-records-platform-v2-and-view-tabs.md`
- `2026-11-05-records-default-status-field.md`
- `2026-11-06-views-sharing-and-custom-column-tabs.md`
- `2026-11-06-records-type-permissions-views-as-lenses.md`
- `2026-11-07-pr82-review-rounds-drop-late-migrations.md`
