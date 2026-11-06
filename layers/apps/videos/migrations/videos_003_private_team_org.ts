import { type Kysely, sql } from 'kysely'

// A video's audience is `private` (its uploader), `team` (one team, `team_id`)
// or `org`; the public link is a separate switch (`link_enabled`). Old
// `public` videos become `org` with the link on.
//
// Private videos are enforced in RLS by restrictive policies keyed on
// `app.current_user`, or, for reads, on a share-link request for that video
// (`app.videos_link`). Restrictive policies only narrow the permissive ones:
// here the single-mode policies (a user is set, or a link read), which
// videos_T004 drops again on tenancy hosts, where the org policy is the
// permissive one.
//
// Team and org videos outlive their uploader: a trigger on `users` clears
// their `user_id` before the cascade deletes the rest, and queues the deleted
// videos' storage keys in `videos_blob_deletes` for removal after commit.
const ME = sql`nullif(current_setting('app.current_user', true), '')`
const LINK = sql`(link_enabled AND share_token = current_setting('app.videos_link', true))`
const MINE_OR_SHARED = sql`(visibility <> 'private' OR user_id = ${ME}::uuid)`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE videos ADD COLUMN link_enabled boolean NOT NULL DEFAULT false`.execute(db)
  await sql`ALTER TABLE videos ADD COLUMN team_id uuid REFERENCES groups(id) ON DELETE RESTRICT`.execute(db)
  await sql`CREATE INDEX videos_team_id_idx ON videos (team_id)`.execute(db)
  await sql`ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_visibility_check`.execute(db)
  await sql`UPDATE videos SET visibility = 'org', link_enabled = true WHERE visibility = 'public'`.execute(db)
  await sql`
    ALTER TABLE videos ADD CONSTRAINT videos_visibility_check
      CHECK (visibility IN ('private', 'team', 'org'))
  `.execute(db)
  await sql`
    ALTER TABLE videos ADD CONSTRAINT videos_team_check
      CHECK ((visibility = 'team') = (team_id IS NOT NULL))
  `.execute(db)
  await sql`ALTER TABLE videos ALTER COLUMN user_id DROP NOT NULL`.execute(db)

  // Share-page counters. Security definer so a signed-out viewer can count.
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
          WHERE share_token = p_token AND (link_enabled OR visibility <> 'private');
      ELSE
        UPDATE videos SET view_count = view_count + 1
          WHERE share_token = p_token AND (link_enabled OR visibility <> 'private');
      END IF;
    END $$
  `.execute(db)

  await sql`ALTER TABLE videos ENABLE ROW LEVEL SECURITY`.execute(db)

  await sql`CREATE POLICY videos_single_read ON videos FOR SELECT USING (${ME} IS NOT NULL OR ${LINK})`.execute(db)
  await sql`CREATE POLICY videos_single_insert ON videos FOR INSERT WITH CHECK (${ME} IS NOT NULL)`.execute(db)
  await sql`CREATE POLICY videos_single_update ON videos FOR UPDATE USING (${ME} IS NOT NULL)`.execute(db)
  await sql`CREATE POLICY videos_single_delete ON videos FOR DELETE USING (${ME} IS NOT NULL)`.execute(db)

  await sql`
    CREATE POLICY videos_private_read ON videos AS RESTRICTIVE FOR SELECT
      USING (${MINE_OR_SHARED} OR ${LINK})
  `.execute(db)
  await sql`CREATE POLICY videos_private_insert ON videos AS RESTRICTIVE FOR INSERT WITH CHECK (${MINE_OR_SHARED})`.execute(db)
  await sql`CREATE POLICY videos_private_update ON videos AS RESTRICTIVE FOR UPDATE USING (${MINE_OR_SHARED})`.execute(db)
  await sql`CREATE POLICY videos_private_delete ON videos AS RESTRICTIVE FOR DELETE USING (${MINE_OR_SHARED})`.execute(db)

  await sql`
    CREATE TABLE videos_blob_deletes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      s3_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION videos_on_user_delete()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    BEGIN
      UPDATE videos SET user_id = NULL WHERE user_id = OLD.id AND visibility <> 'private';
      INSERT INTO videos_blob_deletes (s3_key)
        SELECT k.key FROM videos v
        CROSS JOIN LATERAL (VALUES (v.s3_key), (v.thumbnail_url)) AS k(key)
        WHERE v.user_id = OLD.id AND k.key IS NOT NULL;
      RETURN OLD;
    END $$
  `.execute(db)
  await sql`
    CREATE TRIGGER videos_on_user_delete BEFORE DELETE ON users
      FOR EACH ROW EXECUTE FUNCTION videos_on_user_delete()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS videos_on_user_delete ON users`.execute(db)
  await sql`DROP FUNCTION IF EXISTS videos_on_user_delete()`.execute(db)
  await sql`DROP TABLE IF EXISTS videos_blob_deletes`.execute(db)
  for (const p of ['private_read', 'private_insert', 'private_update', 'private_delete', 'single_read', 'single_insert', 'single_update', 'single_delete']) {
    await sql`DROP POLICY IF EXISTS ${sql.raw(`videos_${p}`)} ON videos`.execute(db)
  }
  // Single-mode hosts had no RLS on videos before this migration.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'videos' AND column_name = 'org_id') THEN
        ALTER TABLE videos DISABLE ROW LEVEL SECURITY;
      END IF;
    END $$
  `.execute(db)
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
  await sql`DELETE FROM videos WHERE user_id IS NULL`.execute(db)
  await sql`ALTER TABLE videos ALTER COLUMN user_id SET NOT NULL`.execute(db)
  await sql`ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_team_check`.execute(db)
  await sql`ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_visibility_check`.execute(db)
  await sql`UPDATE videos SET visibility = 'org' WHERE visibility = 'team'`.execute(db)
  await sql`UPDATE videos SET visibility = 'public' WHERE link_enabled AND visibility = 'org'`.execute(db)
  await sql`
    ALTER TABLE videos ADD CONSTRAINT videos_visibility_check
      CHECK (visibility IN ('private', 'org', 'public'))
  `.execute(db)
  await sql`DROP INDEX IF EXISTS videos_team_id_idx`.execute(db)
  await sql`ALTER TABLE videos DROP COLUMN team_id`.execute(db)
  await sql`ALTER TABLE videos DROP COLUMN link_enabled`.execute(db)
}
