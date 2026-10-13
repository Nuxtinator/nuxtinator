// Social-auth layer schema augmentation (see core's schema.ts for the
// global-merge pattern).
import type { ColumnType, Generated } from 'kysely'

export interface UserIdentitiesTable {
  id: Generated<string>
  user_id: string
  provider: string
  subject: string
  email: string | null
  client_id: string | null
  refresh_token_enc: string | null
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  last_used_at: ColumnType<Date, Date | string | undefined, Date | string>
}

declare global {
  interface NuxtinatorDatabaseTables {
    user_identities: UserIdentitiesTable
  }
}
