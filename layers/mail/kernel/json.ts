import { sql, type RawBuilder } from 'kysely'

// A jsonb value. The `::text::jsonb` cast keeps the driver from encoding the
// already-serialized string a second time (which would store a jsonb string
// scalar instead of an object or array).
export function jsonb<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::text::jsonb`
}
