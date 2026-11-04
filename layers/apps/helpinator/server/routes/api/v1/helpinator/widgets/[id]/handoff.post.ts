// POST /api/v1/helpinator/widgets/:id/handoff — public, bearer session token.
// "Still need help?": the transcript becomes an open, unassigned inbox
// conversation (source 'helpinator') and the typed address gets the inbox's
// fixed auto-ack (no transcript: nothing proves the visitor owns the address).
// At most once per conversation, and only with the inbox app on for the org.
import { z } from 'zod'
import { getHeader } from 'h3'
import { helpinatorWithWidget } from '../../../../../../utils/helpinator-public'
import {
  helpinatorBearer,
  helpinatorClientKey,
  helpinatorEmailKey,
  helpinatorHashSessionToken,
  helpinatorRateLimit
} from '../../../../../../utils/helpinator-guards'
import {
  HelpinatorAlreadyHandedOff,
  helpinatorFindSession,
  helpinatorHandOff,
  helpinatorHandoffAvailable,
  type HelpinatorHandoffResult
} from '../../../../../../utils/helpinator-conversations'

const Body = z.object({ email: z.string().trim().email().max(320) })

export default defineEventHandler(async (event) => {
  const token = helpinatorBearer(event)
  if (!token) throw createError({ statusCode: 401, statusMessage: 'Session token required' })
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'Please enter a valid email address.' })
  const email = parsed.data.email.toLowerCase()
  const sessionHash = helpinatorHashSessionToken(token)
  // The per-client limit comes first: it only ever costs the caller.
  await helpinatorRateLimit(event, 'ratelimit.helpinator.handoff', 'client', helpinatorClientKey(event), 5, 60 * 60_000)

  // Check the session before the per-address limit, so made-up tokens can't
  // use up someone else's handoffs. A widget-wide total needs no limit of its
  // own: each handoff needs a real conversation (once each), and conversations
  // are bounded by the widget's daily message cap.
  const ready = await helpinatorWithWidget(event, async (tx, widget) => {
    if (!widget.enabled) throw createError({ statusCode: 503, statusMessage: 'The help assistant is unavailable right now.' })
    const conversation = await helpinatorFindSession(tx, widget.id, sessionHash)
    if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
    if (!await helpinatorHandoffAvailable(tx)) throw createError({ statusCode: 503, statusMessage: 'Handoff is not available right now.' })
    return !conversation.inbox_conversation_id
  })
  if (!ready) return { status: 'already_handed_off' }

  // Each handoff mails the typed address, so it is limited per address too
  // (however many clients ask).
  await helpinatorRateLimit(event, 'ratelimit.helpinator.handoff.email', 'email', helpinatorEmailKey(email), 3, 24 * 60 * 60_000)

  let result: HelpinatorHandoffResult
  try {
    result = await helpinatorWithWidget(event, async (tx, widget) => {
      if (!widget.enabled) throw createError({ statusCode: 503, statusMessage: 'The help assistant is unavailable right now.' })
      const conversation = await helpinatorFindSession(tx, widget.id, sessionHash)
      if (!conversation) throw createError({ statusCode: 404, statusMessage: 'Conversation not found' })
      return await helpinatorHandOff(tx, {
        conversationId: conversation.id,
        widget,
        email,
        userAgent: getHeader(event, 'user-agent') ?? null
      })
    })
  } catch (err) {
    if (err instanceof HelpinatorAlreadyHandedOff) return { status: 'already_handed_off' }
    throw err
  }

  // Post-commit: staff notification + the auto-ack. Best-effort by contract.
  await result.afterCommit().catch(err => console.warn('[helpinator] handoff side effects failed:', err))
  return { status: 'handed_off' }
})
