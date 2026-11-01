import type { ColumnType, Generated } from 'kysely'
import type { AiProvider } from '../../types/ai-ext'

type Timestamp = ColumnType<Date, string | Date | undefined, string | Date>

export interface AiUsageTable {
  id: Generated<string>
  // Who made the call, when it ran as a user; null once they are deleted.
  user_id: ColumnType<string | null, string | null | undefined, string | null>
  feature: string
  model: string
  provider: AiProvider
  // Whose key paid: the org's own, or the host's.
  key_source: 'org' | 'host'
  prompt_tokens: ColumnType<number, number | undefined, number>
  completion_tokens: ColumnType<number, number | undefined, number>
  // USD, as numeric (pg returns it as a string).
  cost: ColumnType<string | null, number | null | undefined, number | null>
  created_at: Timestamp
}

declare global {
  interface NuxtinatorDatabaseTables {
    ai_usage: AiUsageTable
  }
}
