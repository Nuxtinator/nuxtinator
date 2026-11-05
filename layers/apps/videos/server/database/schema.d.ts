// Adds the videos table to the host schema by merging into core's global
// `NuxtinatorDatabaseTables` registry (resolution-independent — see core's
// server/database/schema.ts).
import type { ColumnType, Generated } from 'kysely'

export type VideoVisibility = 'private' | 'team' | 'org'

export interface VideosTable {
  id: Generated<string>
  // Null once the uploader's account is deleted (team and org videos only).
  user_id: string | null
  org_id: string
  title: string | null
  s3_key: string
  thumbnail_url: string | null
  duration: Generated<number>
  file_size: ColumnType<string | null, string | number | null | undefined, string | number | null>
  width: number | null
  height: number | null
  share_token: string
  visibility: Generated<VideoVisibility>
  // Set only for `team` videos.
  team_id: string | null
  link_enabled: Generated<boolean>
  view_count: Generated<number>
  play_count: Generated<number>
  source: string | null
  original_filename: string | null
  original_file_size: ColumnType<string | null, string | number | null | undefined, string | number | null>
  compression_ratio: ColumnType<string | null, string | number | null | undefined, string | number | null>
  created_at: ColumnType<Date, Date | string | undefined, Date | string>
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>
}

// Storage keys of deleted videos, removed from storage after the delete commits.
export interface VideosBlobDeletesTable {
  id: Generated<string>
  s3_key: string
  created_at: Generated<Date>
}

declare global {
  interface NuxtinatorDatabaseTables {
    videos: VideosTable
    videos_blob_deletes: VideosBlobDeletesTable
  }
}
