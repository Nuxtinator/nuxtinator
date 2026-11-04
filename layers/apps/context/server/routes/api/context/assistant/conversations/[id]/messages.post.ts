// POST /api/context/assistant/conversations/:id/messages
// Send one user message: runs the model with the conversation's stored
// history and scope, persists both turns, and returns them. Proposed section
// updates are parsed only for users who could apply them.
//
// With `Accept: text/event-stream` the same turn streams as server-sent events
// while the transaction stays open: `status` ({ text }) as sections load,
// `delta` ({ text }) as reply text arrives, `reset` when text written before a
// tool call is dropped, `ping` as a keep-alive, then `done` with the JSON
// payload once committed, or `error` ({ statusCode, message }) once rolled
// back. A client that disconnects does not abort the turn: it still commits,
// and the reply shows on the next load.
import { z } from 'zod'
import { createEventStream, getRequestHeader, type H3Event } from 'h3'
import type { Transaction } from 'kysely'
import type { Database } from '#core/server/database/schema'
import { withOrgPermission } from '#tenant/server'
import { isAiConfigured, complete, resolveAiRun, type AiMessage, type AiToolHandler } from '#ai/server'
import {
  getOwnedConversationOr404,
  listMessages,
  insertMessage,
  touchConversation,
  type ConversationRow
} from '../../../../../../utils/assistant-conversations'
import { getContextTeamScope, getPortfolioById } from '../../../../../../utils/portfolio-helpers'
import {
  CONTEXT_ASSISTANT_FEATURE,
  buildAssistantContext,
  contextAssistantSubject,
  historyToMessages,
  scopeFromConversation,
  stripUpdateBlocks,
  type AssistantContext
} from '../../../../../../utils/assistant'

const Body = z.object({
  message: z.string().min(1).max(20_000)
})

const KEEP_ALIVE_MS = 15_000

type Tx = Transaction<Database>

interface TurnArgs {
  conversation: ConversationRow
  message: string
  canApply: boolean
  history: AiMessage[]
  assistant: AssistantContext
}

interface TurnHooks {
  onToolCall: AiToolHandler
  onTextDelta: (text: string) => void
  onTextDiscard: () => void
}

async function runTurn(tx: Tx, args: TurnArgs, hooks?: TurnHooks) {
  const { conversation, message, canApply, history, assistant } = args
  const userMessage = await insertMessage(tx, { conversationId: conversation.id, role: 'user', content: message })

  const run = await resolveAiRun(tx, CONTEXT_ASSISTANT_FEATURE, { subject: contextAssistantSubject(conversation.portfolio_id) })
  const result = await complete({
    run,
    feature: CONTEXT_ASSISTANT_FEATURE,
    system: assistant.system,
    messages: [...history, { role: 'user', content: message }],
    tools: assistant.tools,
    onToolCall: hooks?.onToolCall ?? assistant.onToolCall,
    maxTokens: 4096,
    maxToolRounds: 4,
    onTextDelta: hooks?.onTextDelta,
    onTextDiscard: hooks?.onTextDiscard
  })

  const proposals = canApply
    ? assistant.parseProposals(result.text).map(p => ({ ...p, status: 'pending' as const }))
    : []

  const assistantMessage = await insertMessage(tx, {
    conversationId: conversation.id,
    role: 'assistant',
    content: stripUpdateBlocks(result.text),
    proposals,
    contextLoaded: assistant.contextLoaded
  })
  await touchConversation(tx, conversation.id, history.length === 0 ? message : undefined)

  return { user_message: userMessage, assistant_message: assistantMessage, can_apply: canApply }
}

interface Sse {
  push: (name: string, data: unknown) => Promise<void>
  close: () => Promise<void>
}

// Opens the event stream and sends the headers at once so progress shows
// immediately. The send promise settles when the stream closes and is not
// awaited, so a dropped client cannot abort the turn; pushes after a drop are
// no-ops.
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
  // Set once validation passes and the stream is open; from then on the
  // outcome is reported on the stream rather than as a response.
  const live: { sse: Sse | null } = { sse: null }

  try {
    const payload = await withOrgPermission(event, { appId: 'context' }, 'context.assistant.chat', async (tx, ctx) => {
      const id = getRouterParam(event, 'id') ?? ''
      const teamScope = await getContextTeamScope(event, tx, ctx)
      const conversation = await getOwnedConversationOr404(tx, id, ctx.userId, teamScope)

      const parsed = Body.safeParse(await readBody(event))
      if (!parsed.success) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid body', data: parsed.error.flatten() })
      }
      if (!(await isAiConfigured(tx))) {
        throw createError({ statusCode: 503, statusMessage: 'The assistant is not configured.' })
      }

      const portfolio = conversation.portfolio_id ? await getPortfolioById(tx, conversation.portfolio_id, teamScope) : null
      if (conversation.portfolio_id && !portfolio) {
        throw createError({ statusCode: 404, statusMessage: 'Portfolio not found.' })
      }
      const scope = scopeFromConversation(conversation, portfolio)
      const canApply = ctx.perms.has('context.write') && ctx.perms.has('context.assistant.apply')

      const history = historyToMessages(await listMessages(tx, conversation.id))
      const assistant = await buildAssistantContext(tx, scope, canApply, teamScope, { userMessage: parsed.data.message })
      const args: TurnArgs = { conversation, message: parsed.data.message, canApply, history, assistant }

      if (!wantsStream) return await runTurn(tx, args)

      const sse = openSse(event)
      live.sse = sse
      return await runTurn(tx, args, {
        onToolCall: (name, input) => {
          const what = assistant.describeToolCall(name, input)
          if (what) sse.push('status', { text: `Reading ${what}…` })
          return assistant.onToolCall(name, input)
        },
        onTextDelta: (text) => {
          sse.push('delta', { text })
        },
        onTextDiscard: () => {
          sse.push('reset', {})
        }
      })
    })
    if (!live.sse) return payload
    await live.sse.push('done', payload)
  } catch (err) {
    if (!live.sse) throw err
    const failure = err as { statusCode?: number, statusMessage?: string }
    if (!failure.statusCode || failure.statusCode >= 500) {
      console.error('[context] assistant turn failed mid-stream:', err)
    }
    await live.sse.push('error', {
      statusCode: failure.statusCode ?? 500,
      message: failure.statusMessage ?? 'Something went wrong.'
    })
  } finally {
    await live.sse?.close()
  }
})
