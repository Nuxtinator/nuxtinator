import { type Kysely, sql } from 'kysely'

// Tabs can be calendars: records placed on the days of a date field.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table views_tabs drop constraint if exists views_tabs_layout_check`.execute(db)
  await sql`alter table views_tabs add constraint views_tabs_layout_check
    check (layout in ('kanban', 'table', 'list', 'calendar'))`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table views_tabs drop constraint if exists views_tabs_layout_check`.execute(db)
  await sql`alter table views_tabs add constraint views_tabs_layout_check
    check (layout in ('kanban', 'table', 'list'))`.execute(db)
}
