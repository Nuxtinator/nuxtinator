// One in-flight assistant turn, held in useState so it outlives the panel:
// closing the slideover or navigating within the app keeps the stream running
// and the panel applies the outcome when it next renders. A full page load
// drops the stream; the server still finishes the turn and the reply shows
// the next time the conversation loads.
import type { AssistantMessage } from './useContextAssistant'
import { readSseBody, splitStreamingReply } from '../utils/assistant-stream'

export interface AssistantTurnResult {
  user_message: AssistantMessage
  assistant_message: AssistantMessage
  can_apply: boolean
}

export interface AssistantTurn {
  conversationId: string
  userText: string
  // Latest progress line, shown until reply text starts.
  status: string
  // Reply text streamed so far, update blocks included.
  text: string
  result: AssistantTurnResult | null
  error: string | null
  // The stream dropped before the turn settled; the server finishes it.
  lost: boolean
}

const LOST_MESSAGE = 'The connection dropped. The reply will appear the next time this chat is opened.'

function failureMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, statusMessage?: string, message?: string } | null
  return err?.data?.statusMessage || err?.statusMessage || err?.message || 'Something went wrong.'
}

export function useContextAssistantTurn() {
  const turn = useState<AssistantTurn | null>('context-assistant.turn', () => null)
  const inFlight = computed(() => !!turn.value && !turn.value.result && !turn.value.error)
  // What the panel renders while text streams: the reply without its update
  // blocks, and the sections those blocks are drafting.
  const display = computed(() => turn.value ? splitStreamingReply(turn.value.text) : null)

  async function start(conversationId: string, text: string): Promise<void> {
    turn.value = { conversationId, userText: text, status: 'Thinking…', text: '', result: null, error: null, lost: false }
    const current = turn.value
    let started = false
    let settled = false
    try {
      const url: string = `/api/context/assistant/conversations/${conversationId}/messages`
      const body = (await $fetch(url, {
        method: 'POST',
        body: { message: text },
        headers: { Accept: 'text/event-stream' },
        responseType: 'stream'
      })) as ReadableStream<Uint8Array>
      for await (const frame of readSseBody(body)) {
        started = true
        const data = frame.data ? JSON.parse(frame.data) : {}
        if (frame.event === 'status') {
          current.status = String(data.text ?? '')
        } else if (frame.event === 'delta') {
          current.text += String(data.text ?? '')
        } else if (frame.event === 'reset') {
          current.text = ''
        } else if (frame.event === 'done') {
          current.result = data
          settled = true
        } else if (frame.event === 'error') {
          current.error = String(data.message || 'Something went wrong.')
          settled = true
        }
        if (settled) break
      }
      if (!settled) {
        current.lost = true
        current.error = LOST_MESSAGE
      }
    } catch (e) {
      if (settled) return
      current.lost = started
      current.error = started ? LOST_MESSAGE : failureMessage(e)
    }
  }

  function clear() {
    turn.value = null
  }

  return { turn, inFlight, display, start, clear }
}
