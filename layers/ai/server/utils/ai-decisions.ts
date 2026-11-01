// Request and response translation for decision models, which answer typed
// questions about an input with probabilities instead of text. OpenRouter
// (`POST /api/alpha/decisions`) and Tinfoil (`POST /v1/decisions`) take the
// same three question types in different shapes; `decide()` speaks one shape
// (AiDecisionQuestion / AiDecisionAnswer) and these map it onto each. Pure —
// unit-tested without Nuxt or a network.
import type { AiDecisionAnswer, AiDecisionQuestion } from '../../types/ai-ext'

type Questions = Record<string, AiDecisionQuestion>
type Input = string | Record<string, unknown> | unknown[]

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function prob(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// OpenRouter calls a yes/no question `noul` and requires both criteria; a
// choice's criteria map each option to its description.
export function toOpenRouterDecisionBody(model: string, input: Input, questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, q] of Object.entries(questions)) {
    switch (q.type) {
      case 'predicate':
        out[name] = { type: 'noul', instructions: q.instructions, criteria: q.criteria ?? { true: 'Yes', false: 'No' } }
        break
      case 'choice':
        out[name] = {
          type: 'choice',
          instructions: q.instructions,
          criteria: Object.fromEntries(q.choices.map(c => [c.value, c.description ?? c.value]))
        }
        break
      case 'score':
        out[name] = { type: 'score', instructions: q.instructions, criteria: q.levels }
        break
    }
  }
  return { model, state: input, questions: out }
}

// Tinfoil questions carry no criteria or option descriptions, so those are
// written into the instructions. Its input is text, so JSON input is sent
// serialized.
export function toTinfoilDecisionBody(model: string, input: Input, questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown>[] = []
  for (const [name, q] of Object.entries(questions)) {
    switch (q.type) {
      case 'predicate':
        out.push({
          name,
          type: 'predicate',
          instructions: q.criteria
            ? `${q.instructions}\nTrue if: ${q.criteria.true}\nFalse if: ${q.criteria.false}`
            : q.instructions
        })
        break
      case 'choice': {
        const described = q.choices.filter(c => c.description)
        out.push({
          name,
          type: 'choice',
          instructions: described.length
            ? `${q.instructions}\n${described.map(c => `- ${c.value}: ${c.description}`).join('\n')}`
            : q.instructions,
          choices: q.choices.map(c => ({ value: c.value }))
        })
        break
      }
      case 'score':
        out.push({ name, type: 'score', instructions: q.instructions, levels: q.levels.map(label => ({ label })) })
        break
    }
  }
  return { model, input: typeof input === 'string' ? input : JSON.stringify(input), questions: out }
}

// `{ answers: { <name>: { type: 'noul' | 'choice' | 'score', … } } }`. Score
// probabilities are keyed by level index.
export function fromOpenRouterDecisionResponse(payload: unknown, questions: Questions): Record<string, AiDecisionAnswer> {
  const answers = asRecord(asRecord(payload)?.answers) ?? {}
  const out: Record<string, AiDecisionAnswer> = {}
  for (const [name, q] of Object.entries(questions)) {
    const a = asRecord(answers[name])
    if (!a) continue
    if (q.type === 'predicate') {
      const p = prob(a.noul)
      if (p !== null) out[name] = { type: 'predicate', probability: p }
    } else if (q.type === 'choice') {
      const probs = asRecord(a.probabilities) ?? {}
      const choice = typeof a.choice === 'string' ? a.choice : ''
      if (!choice) continue
      out[name] = {
        type: 'choice',
        choice,
        confidence: prob(a.confidence) ?? prob(probs[choice]) ?? 0,
        probabilities: Object.fromEntries(q.choices.map(c => [c.value, prob(probs[c.value]) ?? 0]))
      }
    } else {
      const probs = asRecord(a.probabilities) ?? {}
      const score = prob(a.score)
      if (score === null) continue
      const levels = q.levels.map((_, i) => prob(probs[String(i)]) ?? 0)
      out[name] = { type: 'score', score, confidence: prob(a.confidence) ?? Math.max(...levels), probabilities: levels }
    }
  }
  return out
}

// `{ answers: [{ name, type: 'predicate' | 'choice' | 'score', … }] }`, with
// probabilities as `{ value, probability }` lists (a score's `value` is the
// level index).
export function fromTinfoilDecisionResponse(payload: unknown, questions: Questions): Record<string, AiDecisionAnswer> {
  const list = asRecord(payload)?.answers
  const byName = new Map<string, Record<string, unknown>>()
  for (const raw of Array.isArray(list) ? list : []) {
    const a = asRecord(raw)
    if (a && typeof a.name === 'string') byName.set(a.name, a)
  }
  const out: Record<string, AiDecisionAnswer> = {}
  for (const [name, q] of Object.entries(questions)) {
    const a = byName.get(name)
    if (!a) continue
    const probs = new Map<string, number>()
    for (const raw of Array.isArray(a.probabilities) ? a.probabilities : []) {
      const entry = asRecord(raw)
      const p = prob(entry?.probability)
      if (entry && p !== null) probs.set(String(entry.value), p)
    }
    if (q.type === 'predicate') {
      const p = prob(a.probability)
      if (p !== null) out[name] = { type: 'predicate', probability: p }
    } else if (q.type === 'choice') {
      const choice = typeof a.choice === 'string' ? a.choice : ''
      if (!choice) continue
      out[name] = {
        type: 'choice',
        choice,
        confidence: prob(a.confidence) ?? probs.get(choice) ?? 0,
        probabilities: Object.fromEntries(q.choices.map(c => [c.value, probs.get(c.value) ?? 0]))
      }
    } else {
      const score = prob(a.score)
      if (score === null) continue
      const levels = q.levels.map((_, i) => probs.get(String(i)) ?? 0)
      out[name] = { type: 'score', score, confidence: prob(a.confidence) ?? Math.max(...levels), probabilities: levels }
    }
  }
  return out
}
