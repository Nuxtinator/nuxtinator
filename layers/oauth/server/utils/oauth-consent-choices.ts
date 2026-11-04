// What a user chose for a connected app: the scopes it may use (`scope`) and
// the ones they turned down (`declined_scope`), which the consent screen
// doesn't ask about again. One set of choices per connection: in multi mode
// consents are stored per org, so a change is written to the connection's
// consent in every org scope.
import { sql } from 'kysely'
import { db } from '#core/server/utils/database'
import { listOrgScopes, withOrgScope } from '#tenant/server'
import { parseScopeString } from './oauth-validation'

export interface ConsentChoices {
  granted: string[]
  declined: string[]
}

export function choicesFromRow(row: { scope: string, declined_scope: string } | null | undefined): ConsentChoices | null {
  if (!row) return null
  return { granted: parseScopeString(row.scope), declined: parseScopeString(row.declined_scope) }
}

// Folds a consent-screen answer into earlier choices: of the `requested`
// scopes the screen showed, `chosen` were ticked.
export function mergeConsentChoices(prev: ConsentChoices | null, requested: string[], chosen: string[]): ConsentChoices {
  const asked = new Set(requested)
  const ticked = new Set(chosen)
  const granted = new Set([...(prev?.granted ?? []).filter(s => !asked.has(s)), ...chosen])
  const declined = new Set([
    ...(prev?.declined ?? []).filter(s => !ticked.has(s)),
    ...requested.filter(s => !ticked.has(s))
  ])
  for (const s of granted) declined.delete(s)
  return { granted: [...granted], declined: [...declined] }
}

// True when earlier choices answer every scope in `requested`.
export function choicesCover(choices: ConsentChoices | null, requested: string[]): boolean {
  if (!choices) return false
  const answered = new Set([...choices.granted, ...choices.declined])
  return requested.every(s => answered.has(s))
}

// The connection's choices across every org scope it has a live consent in.
export async function loadConsentChoices(userId: string, clientId: string): Promise<ConsentChoices | null> {
  const granted = new Set<string>()
  const declined = new Set<string>()
  let found = false
  for (const orgId of await listOrgScopes()) {
    const rows = await withOrgScope(orgId, tx => tx
      .selectFrom('oauth_consents')
      .select(['scope', 'declined_scope'])
      .where('user_id', '=', userId)
      .where('client_id', '=', clientId)
      .where('revoked', '=', false)
      .execute())
    for (const row of rows) {
      found = true
      for (const s of parseScopeString(row.scope)) granted.add(s)
      for (const s of parseScopeString(row.declined_scope)) declined.add(s)
    }
  }
  if (!found) return null
  for (const s of granted) declined.delete(s)
  return { granted: [...granted], declined: [...declined] }
}

// Writes `choices` to the connection's live consent in every org scope.
export async function saveConsentChoices(userId: string, clientId: string, choices: ConsentChoices): Promise<void> {
  for (const orgId of await listOrgScopes()) {
    await withOrgScope(orgId, tx => tx
      .updateTable('oauth_consents')
      .set({ scope: choices.granted.join(' '), declined_scope: choices.declined.join(' '), updated: new Date() })
      .where('user_id', '=', userId)
      .where('client_id', '=', clientId)
      .where('revoked', '=', false)
      .execute())
  }
}

function scopeArray(scopes: string[]) {
  return sql`array[${sql.join(scopes)}]::text[]`
}

// Applies an edit to the connection's live tokens. A removed scope stops
// working at once, on the access and refresh tokens; an added one is put on
// the refresh tokens only, so it arrives with the next refresh and a token
// never widens mid-life.
export async function applyChoicesToTokens(
  userId: string,
  clientId: string,
  change: { removed: string[], added: string[] }
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (change.removed.length > 0) {
      const strip = sql<string>`array_to_string(array(select s from unnest(string_to_array(scope, ' ')) as s where not (s = any(${scopeArray(change.removed)}))), ' ')`
      for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens'] as const) {
        await trx
          .updateTable(table)
          .set({ scope: strip })
          .where('user_id', '=', userId)
          .where('client_id', '=', clientId)
          .where('revoked', '=', false)
          .execute()
      }
    }
    if (change.added.length > 0) {
      await trx
        .updateTable('oauth_refresh_tokens')
        .set({ scope: sql<string>`array_to_string(array(select distinct s from unnest(string_to_array(scope, ' ') || ${scopeArray(change.added)}) as s where s <> ''), ' ')` })
        .where('user_id', '=', userId)
        .where('client_id', '=', clientId)
        .where('revoked', '=', false)
        .where('used', '=', false)
        .execute()
    }
  })
}
