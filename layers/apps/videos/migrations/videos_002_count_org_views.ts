import { type Kysely, sql } from 'kysely'

// Counters include org-shared videos: `bump_video_counter` matches
// `visibility IN ('public', 'org')`, so views/plays by org members count
// alongside public ones. The share endpoints gate who may call it. Like
// videos_001, this is the single-tenant variant; the tenancy retrofit
// (videos_T002) replaces it with a SECURITY DEFINER version.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION bump_video_counter(p_token text, p_kind text)
    RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
      IF p_kind NOT IN ('play', 'view') THEN
        RAISE EXCEPTION 'invalid kind';
      END IF;
      IF p_kind = 'play' THEN
        UPDATE videos SET play_count = play_count + 1
          WHERE share_token = p_token AND visibility IN ('public', 'org');
      ELSE
        UPDATE videos SET view_count = view_count + 1
          WHERE share_token = p_token AND visibility IN ('public', 'org');
      END IF;
    END $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore the public-only variant from videos_001.
  await sql`
    CREATE OR REPLACE FUNCTION bump_video_counter(p_token text, p_kind text)
    RETURNS void
    LANGUAGE plpgsql AS $$
    BEGIN
      IF p_kind NOT IN ('play', 'view') THEN
        RAISE EXCEPTION 'invalid kind';
      END IF;
      IF p_kind = 'play' THEN
        UPDATE videos SET play_count = play_count + 1
          WHERE share_token = p_token AND visibility = 'public';
      ELSE
        UPDATE videos SET view_count = view_count + 1
          WHERE share_token = p_token AND visibility = 'public';
      END IF;
    END $$
  `.execute(db)
}
