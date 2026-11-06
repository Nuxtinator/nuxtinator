import { type Kysely, sql } from 'kysely'

// Per-app tenancy migration, paired with videos_003. On a tenancy host the
// org policy (`videos_tenant_write`) is the permissive one, so the
// single-mode policies videos_003 adds would widen it to every org: drop
// them. The restrictive private-video policies stay.
//
// Also recreates the counter as videos_003 defines it (videos_T001 and
// videos_T002 replace it on a fresh host), and adds the definer function org
// offboarding reads storage keys through, since an offboarding transaction
// has no user and RLS hides private videos from it.
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const p of ['single_read', 'single_insert', 'single_update', 'single_delete']) {
    await sql`DROP POLICY IF EXISTS ${sql.raw(`videos_${p}`)} ON videos`.execute(db)
  }

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

  // Storage keys of every video in the transaction's org.
  await sql`
    CREATE OR REPLACE FUNCTION videos_org_storage_keys()
    RETURNS TABLE (s3_key text, thumbnail_url text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT v.s3_key, v.thumbnail_url FROM videos v
      WHERE v.org_id = nullif(current_setting('app.current_org', true), '')::uuid
    $$
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS videos_org_storage_keys()`.execute(db)
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
  const ME = sql`nullif(current_setting('app.current_user', true), '')`
  const LINK = sql`(link_enabled AND share_token = current_setting('app.videos_link', true))`
  await sql`CREATE POLICY videos_single_read ON videos FOR SELECT USING (${ME} IS NOT NULL OR ${LINK})`.execute(db)
  await sql`CREATE POLICY videos_single_insert ON videos FOR INSERT WITH CHECK (${ME} IS NOT NULL)`.execute(db)
  await sql`CREATE POLICY videos_single_update ON videos FOR UPDATE USING (${ME} IS NOT NULL)`.execute(db)
  await sql`CREATE POLICY videos_single_delete ON videos FOR DELETE USING (${ME} IS NOT NULL)`.execute(db)
}
