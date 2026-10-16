// POST /api/v1/helpinator/widgets/:id/messages — public. One visitor turn.
//
// The server holds the transcript: the widget sends only the new message plus
// its bearer session token (none on the first turn — the conversation is then
// created and its token returned). A token that is unknown, belongs to another
// widget, or whose conversation has ended starts a fresh conversation
// (`reset: true`), so the widget drops its cached copy.
//
// With `Accept: text/event-stream` the turn streams as server-sent events:
// `session` ({ token, conversationId, reset }) first, `status` ({ text }) as
// sections load, `delta` ({ text }) as reply text arrives, `discard` when text
// written before a tool call is dropped, `ping` keep-alives, then `done` with
// the JSON payload once committed, or `error` ({ statusCode, message }).
import { z } from 'zod'
import { createEventStream, getHeader, getRequestHeader, type H3Event } from 'h3'
import { sql } from 'kysely'
import { complete, resolveAiRun } from '#ai/server'
import { helpinatorWithWidget } from '../../../../../../utils/helpinator-public'
import {
  HELPINATOR_MAX_MESSAGE_CHARS,
  HELPINATOR_MAX_VISITOR_MESSAGES,
  helpinatorBearer,
  helpinatorClientKey,
  helpinatorCurrentScope,
  helpinatorHashSessionToken,
  helpinatorMessagesToday,
  helpinatorNewSessionToken,
  helpinatorPageUrl,
  helpinatorRateLimit,
  helpinatorScope
} from '../../../../../../utils/helpinator-guards'
import {
  helpinatorCreateConversation,
  helpinatorDeleteMessage,
  helpinatorHandoffAvailable,
  helpinatorFindSession,
  helpinatorInsertMessage,
  helpinatorIsLive,
  helpinatorListMessages,
  helpinatorPublicMessage
} from '../../../../../../utils/helpinator-conversations'
import {
  HELPINATOR_CHAT_FEATURE,
  helpinatorAiReady,
  helpinatorBuildBot,
  helpinatorHistoryToMessages
} from '../../../../../../utils/helpinator-bot'
import { helpinatorGetLibraries } from '../../../../../../utils/helpinator-libraries'
import { helpinatorEmbedRun } from '../../../../../../utils/helpinator-search'

const Body = z.object({
  message: z.string().trim().min(1).max(HELPINATOR_MAX_MESSAGE_CHARS),
  pageUrl: z.string().max(2000).optional()
})

const KEEP_ALIVE_MS = 15_000

interface Sse {
  push: (name: string, data: unknown) => Promise<void>
  close: () => Promise<void>
}

// Opens the stream and sends headers at once. The send promise is not awaited,
// so a dropped client cannot abort the turn; pushes after a drop are no-ops.
function openSse(event: H3Event): Sse {
  const stream = createEventStream(event)
  const keepAlive = setInterval(() => {
    stream.push({ event: 'ping', data: '{}' }).catch(() => {})
  }, KEEP_ALIVE_MS)
  stream.send().catch(() => {})
  return {
    push: (name, data) => stream.push({ event: name, data: JSON.stringify(data) }).catch(() => {}),
    close: async () => {
      clearInterval(keepAlive)
      await stream.close()
    }
  }
}

export default defineEventHandler(async (event) => {
  const wantsStream = (getRequestHeader(event, 'accept') ?? '').includes('text/event-stream')
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: `Please keep messages under ${HELPINATOR_MAX_MESSAGE_CHARS} characters.` })
  }
  const client = helpinatorClientKey(event)
  await helpinatorRateLimit(event, 'ratelimit.helpinator.message', 'client', client, 8, 60_000)
  await helpinatorRateLimit(event, 'ratelimit.helpinator.message.hour', 'client', client, 60, 60 * 60_000)
  // So one client can't take a widget offline by burning its daily cap.
  await helpinatorRateLimit(event, 'ratelimit.helpinator.message.day', 'client', client, 200, 24 * 60 * 60_000)

  const presentedToken = helpinatorBearer(event)
  const live: { sse: Sse | null } = { sse: null }

  try {
    // Phase 1, one short tx: gates, the conversation, its history and
    // libraries, and the AI runs. Nothing below holds a DB connection while
    // waiting on the model; each read or write opens its own short tx.
    const prep = await helpinatorWithWidget(event, async (tx, widget, origin) => {
      if (!widget.enabled || widget.library_ids.length === 0 || !(await helpinatorAiReady(tx, widget.chat_model))) {
        throw createError({ statusCode: 503, statusMessage: 'The help assistant is unavailable right now.' })
      }
      // Serialise the cap check with the insert below (per widget), so
      // parallel turns can't all read the same count and overshoot.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`helpinator-cap:${widget.id}`}, 0))`.execute(tx)
      if ((await helpinatorMessagesToday(tx, widget.id)) >= widget.daily_message_cap) {
        throw createError({ statusCode: 429, statusMessage: 'The help assistant is very busy right now — please try again later.' })
      }

      // Resolve (or start) the conversation.
      let conversation = presentedToken
        ? await helpinatorFindSession(tx, widget.id, helpinatorHashSessionToken(presentedToken))
        : null
      let token = presentedToken
      const reset = Boolean(presentedToken) && (!conversation || !helpinatorIsLive(conversation, widget))
      if (!conversation || !helpinatorIsLive(conversation, widget)) {
        token = helpinatorNewSessionToken()
        conversation = await helpinatorCreateConversation(tx, {
          widget,
          sessionHash: helpinatorHashSessionToken(token),
          pageUrl: helpinatorPageUrl(parsed.data.pageUrl),
          origin,
          userAgent: getHeader(event, 'user-agent') ?? null
        })
      }
      if (conversation.visitor_message_count >= HELPINATOR_MAX_VISITOR_MESSAGES) {
        throw createError({ statusCode: 429, statusMessage: 'This conversation has reached its limit — please start a new one.' })
      }

      const history = helpinatorHistoryToMessages(await helpinatorListMessages(tx, conversation.id))
      // The conversation's snapshot of the binding; RLS hides any library
      // that is not this org's, and an empty result means unavailable.
      const libraries = await helpinatorGetLibraries(tx, conversation.library_ids)
      if (libraries.length === 0) {
        throw createError({ statusCode: 503, statusMessage: 'The help assistant is unavailable right now.' })
      }
      // Reserves this turn's slot under the cap lock. Removed again if the
      // turn fails, so a failed turn leaves no unanswered message.
      const userMessage = await helpinatorInsertMessage(tx, {
        conversationId: conversation.id,
        role: 'user',
        content: parsed.data.message
      })
      return {
        widget,
        conversation,
        userMessage,
        session: { token: token!, conversationId: conversation.id, reset },
        history,
        libraries,
        chatRun: await resolveAiRun(tx, HELPINATOR_CHAT_FEATURE, { model: widget.chat_model }),
        embedRun: await helpinatorEmbedRun(tx),
        handoffAvailable: await helpinatorHandoffAvailable(tx),
        scope: helpinatorScope(await helpinatorCurrentScope(tx))
      }
    })

    const turn = async () => {
      const bot = await helpinatorBuildBot(prep.scope, {
        libraries: prep.libraries,
        defaultLibraryId: prep.conversation.default_library_id,
        defaultSectionKey: prep.widget.default_section_key,
        extraInstructions: prep.widget.extra_instructions,
        handoffAvailable: prep.handoffAvailable,
        userMessage: parsed.data.message,
        embedRun: prep.embedRun
      })

      let sse: Sse | null = null
      if (wantsStream) {
        sse = openSse(event)
        live.sse = sse
        await sse.push('session', prep.session)
      }

      const result = await complete({
        run: prep.chatRun,
        feature: HELPINATOR_CHAT_FEATURE,
        system: bot.system,
        messages: [...prep.history, { role: 'user', content: parsed.data.message }],
        tools: bot.tools,
        onToolCall: (name, input) => {
          const what = bot.describeToolCall(name, input)
          if (sse && what) sse.push('status', { text: `Reading ${what}…` })
          return bot.onToolCall(name, input)
        },
        maxTokens: 1500,
        maxToolRounds: 3,
        onTextDelta: sse ? (text) => { sse!.push('delta', { text }) } : undefined,
        onTextDiscard: sse ? () => { sse!.push('discard', {}) } : undefined
      })

      // Phase 3, one short tx: the reply.
      const reply = result.text.trim() || 'Sorry — I could not come up with an answer to that.'
      return await prep.scope(async (tx) => {
        const assistantMessage = await helpinatorInsertMessage(tx, {
          conversationId: prep.conversation.id,
          role: 'assistant',
          content: reply,
          pagesLoaded: bot.pagesLoaded,
          searches: bot.searches,
          searchHits: bot.searchHits,
          model: result.model
        })
        return {
          ...prep.session,
          userMessage: helpinatorPublicMessage(prep.userMessage),
          assistantMessage: helpinatorPublicMessage(assistantMessage)
        }
      })
    }
    let payload: Awaited<ReturnType<typeof turn>>
    try {
      payload = await turn()
    } catch (err) {
      // Give back the reserved slot: no unanswered message stays behind.
      await prep.scope(tx => helpinatorDeleteMessage(tx, prep.userMessage))
        .catch(e => console.warn('[helpinator] could not remove a failed turn\'s message:', e))
      throw err
    }
    if (!live.sse) return payload
    await live.sse.push('done', payload)
  } catch (err) {
    if (!live.sse) throw err
    const failure = err as { statusCode?: number, statusMessage?: string }
    if (!failure.statusCode || failure.statusCode >= 500) {
      console.error('[helpinator] turn failed mid-stream:', err)
    }
    await live.sse.push('error', {
      statusCode: failure.statusCode ?? 500,
      message: failure.statusCode && failure.statusCode < 500
        ? failure.statusMessage
        : 'Something went wrong — please try again.'
    })
  } finally {
    await live.sse?.close()
  }
})
