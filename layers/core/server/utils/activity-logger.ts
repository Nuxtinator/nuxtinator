import { db } from './database'
import crypto from 'crypto'
import type { H3Event } from 'h3'
import type { Kysely, Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { getAuthUser } from './auth'
import { currentOauthClientId } from './bearer-auth'

type Executor = Kysely<Database> | Transaction<Database>

interface LogEventOptions {
  eventType: string
  tableName?: string
  recordId?: string
  userId?: string
  userAgent?: string
  metadata?: Record<string, any>
  // Defaults to the OAuth client the current request runs on behalf of.
  clientId?: string | null
}

// Audit log writer.
//
// Multi-tenant deployments retrofit `activity_logs` with `org_id uuid DEFAULT current_org_id()`
// (see `optional-tenancy/migrations/tenancy_011_retrofit_activity_logs.ts`).
// INSERTs that happen inside `defineTenantHandler`'s transaction get the
// active org stamped automatically via the column DEFAULT. Writes from
// autocommit `db` (this file) get NULL for `org_id` — that's the right
// behavior for global events like LOGIN_FAILED.
//
// The audit row commits independently of any caller transaction. If a
// caller's txn rolls back, the audit row remains as a record of the attempt
// — the right semantics for security auditing.
export async function logEvent(
  options: LogEventOptions,
  executor: Executor = db,
  opts: { throwOnError?: boolean } = {}
): Promise<void> {
  try {
    await executor
      .insertInto('activity_logs')
      .values({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        event_type: options.eventType,
        table_name: options.tableName ?? null,
        record_id: options.recordId ?? null,
        user_id: options.userId ?? null,
        user_agent: options.userAgent ?? null,
        metadata: options.metadata ?? {},
        client_id: options.clientId ?? currentOauthClientId()
      })
      .execute()
  } catch (error) {
    if (opts.throwOnError) throw error
    console.error('Failed to log activity:', error)
  }
}

/**
 * Helper to extract user info from H3Event
 */
function getUserInfoFromEvent(event: H3Event | null): { userId?: string, userAgent?: string } {
  if (!event) return {}

  const user = getAuthUser(event)
  const userAgent = getHeader(event, 'user-agent') || undefined
  const bearer = event.context.bearerIdentity as { userId: string } | undefined

  return {
    userId: bearer?.userId ?? user?.userId,
    userAgent
  }
}

/**
 * Log a CREATE event
 */
export function logCreate(
  tableName: string,
  recordId: string,
  userIdOrEvent?: string | H3Event,
  metadata?: any
): void {
  let userId: string | undefined
  let userAgent: string | undefined

  if (typeof userIdOrEvent === 'string') {
    userId = userIdOrEvent
  } else if (userIdOrEvent) {
    const info = getUserInfoFromEvent(userIdOrEvent)
    userId = info.userId
    userAgent = info.userAgent
  }

  logEvent({
    eventType: 'CREATE',
    tableName,
    recordId,
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log an UPDATE event
 */
export function logUpdate(
  tableName: string,
  recordId: string,
  userIdOrEvent?: string | H3Event,
  metadata?: any
): void {
  let userId: string | undefined
  let userAgent: string | undefined

  if (typeof userIdOrEvent === 'string') {
    userId = userIdOrEvent
  } else if (userIdOrEvent) {
    const info = getUserInfoFromEvent(userIdOrEvent)
    userId = info.userId
    userAgent = info.userAgent
  }

  logEvent({
    eventType: 'UPDATE',
    tableName,
    recordId,
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log a DELETE event
 */
export function logDelete(
  tableName: string,
  recordId: string,
  userIdOrEvent?: string | H3Event,
  metadata?: any
): void {
  let userId: string | undefined
  let userAgent: string | undefined

  if (typeof userIdOrEvent === 'string') {
    userId = userIdOrEvent
  } else if (userIdOrEvent) {
    const info = getUserInfoFromEvent(userIdOrEvent)
    userId = info.userId
    userAgent = info.userAgent
  }

  logEvent({
    eventType: 'DELETE',
    tableName,
    recordId,
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log a successful LOGIN event
 */
export function logLogin(
  userId: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'LOGIN',
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log a failed LOGIN attempt
 * Note: email must be stored in metadata.email for privacy
 */
export function logLoginFailed(
  email: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'LOGIN_FAILED',
    userAgent,
    metadata: {
      ...metadata,
      email
    }
  })
}

/**
 * Log a LOGOUT event
 */
export function logLogout(
  userId: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'LOGOUT',
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log a PASSWORD_RESET event
 */
export function logPasswordReset(
  userId: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'PASSWORD_RESET',
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log an EMAIL_CHANGE event
 */
export function logEmailChange(
  userId: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'EMAIL_CHANGE',
    userId,
    userAgent,
    metadata
  })
}

/**
 * Log a registration attempt (for rate limiting by IP)
 */
export function logRegisterAttempt(
  ip: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'REGISTER_ATTEMPT',
    userAgent,
    metadata: { ...metadata, ip }
  })
}

/**
 * Log a password reset request (for rate limiting by email)
 */
export function logPasswordResetRequest(
  email: string,
  userAgent?: string,
  metadata?: any
): void {
  logEvent({
    eventType: 'PASSWORD_RESET_REQUEST',
    userAgent,
    metadata: { ...metadata, email }
  })
}
