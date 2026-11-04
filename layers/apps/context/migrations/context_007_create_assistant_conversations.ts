import { type Kysely, sql } from 'kysely'

// Persisted assistant chats. A conversation belongs to one user and is scoped
// by which of `portfolio_id` / `section_key` are set: both null = every
// portfolio in the workspace, portfolio only = that portfolio, both = one
// section. Messages carry the assistant's proposed section updates as JSON so
// a user can come back and apply or reject them later.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE context_assistant_conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      portfolio_id uuid REFERENCES context_portfolios(id) ON DELETE CASCADE,
      section_key text,
      title text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT context_assistant_conversations_section_needs_portfolio
        CHECK (section_key IS NULL OR portfolio_id IS NOT NULL)
    )
  `.execute(db)

  await sql`
    CREATE INDEX context_assistant_conversations_user_idx
      ON context_assistant_conversations (user_id, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE context_assistant_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES context_assistant_conversations(id) ON DELETE CASCADE,
      role text NOT NULL,
      content text NOT NULL,
      proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
      context_loaded jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE INDEX context_assistant_messages_conversation_idx
      ON context_assistant_messages (conversation_id, created_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS context_assistant_messages`.execute(db)
  await sql`DROP TABLE IF EXISTS context_assistant_conversations`.execute(db)
}
