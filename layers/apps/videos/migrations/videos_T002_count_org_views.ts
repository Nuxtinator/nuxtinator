import { type Kysely, sql } from 'kysely'

// Tenancy variant of videos_002: the same `visibility IN ('public', 'org')`
// counter filter, kept SECURITY DEFINER so the no-GUC share endpoints can
// write past the RLS write policy. Tenancy migrations sort after regular
// ones, so this definition is the live one in multi-tenant deploys.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION bump_video_counter(p_token text, p_kind text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  // Restore the public-only SECURITY DEFINER variant from videos_T001.
  await sql`
    CREATE OR REPLACE FUNCTION bump_video_counter(p_token text, p_kind text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
