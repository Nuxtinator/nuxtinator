// Pure-function coverage for the decision request/response translation to
// OpenRouter's and Tinfoil's decisions APIs. No Nuxt build needed.
import { describe, it, expect } from 'vitest'
import type { AiDecisionQuestion } from '../../types/ai-ext'
import {
  fromOpenRouterDecisionResponse,
  fromTinfoilDecisionResponse,
  toOpenRouterDecisionBody,
  toTinfoilDecisionBody
} from '../../server/utils/ai-decisions'

const questions: Record<string, AiDecisionQuestion> = {
  escalate: { type: 'predicate', instructions: 'Should this go to a human?', criteria: { true: 'Angry or legal', false: 'Routine' } },
  team: {
    type: 'choice',
    instructions: 'Which team?',
    choices: [{ value: 'billing', description: 'Charges and refunds' }, { value: 'shipping' }]
  },
  urgency: { type: 'score', instructions: 'How urgent?', levels: ['routine', 'soon', 'critical'] }
}

describe('toOpenRouterDecisionBody', () => {
  it('keys questions by name with criteria, sending input as state', () => {
    expect(toOpenRouterDecisionBody('typesafe/jev-1.14', { ticket: 'x' }, questions)).toEqual({
      model: 'typesafe/jev-1.14',
      state: { ticket: 'x' },
      questions: {
        escalate: { type: 'noul', instructions: 'Should this go to a human?', criteria: { true: 'Angry or legal', false: 'Routine' } },
        team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges and refunds', shipping: 'shipping' } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['routine', 'soon', 'critical'] }
      }
    })
  })

  it('gives a predicate without criteria plain yes/no criteria', () => {
    const body = toOpenRouterDecisionBody('m', 'text', { q: { type: 'predicate', instructions: 'Spam?' } })
    expect((body.questions as Record<string, unknown>).q).toEqual({ type: 'noul', instructions: 'Spam?', criteria: { true: 'Yes', false: 'No' } })
  })
})

describe('toTinfoilDecisionBody', () => {
  it('lists named questions and folds criteria and descriptions into the instructions', () => {
    expect(toTinfoilDecisionBody('decision-small', 'Charged twice', questions)).toEqual({
      model: 'decision-small',
      input: 'Charged twice',
      questions: [
        { name: 'escalate', type: 'predicate', instructions: 'Should this go to a human?\nTrue if: Angry or legal\nFalse if: Routine' },
        { name: 'team', type: 'choice', instructions: 'Which team?\n- billing: Charges and refunds', choices: [{ value: 'billing' }, { value: 'shipping' }] },
        { name: 'urgency', type: 'score', instructions: 'How urgent?', levels: [{ label: 'routine' }, { label: 'soon' }, { label: 'critical' }] }
      ]
    })
  })

  it('serializes JSON input', () => {
    expect(toTinfoilDecisionBody('m', { a: 1 }, {}).input).toBe('{"a":1}')
  })
})

describe('fromOpenRouterDecisionResponse', () => {
  it('maps noul, choice and score answers', () => {
    const out = fromOpenRouterDecisionResponse({
      answers: {
        escalate: { type: 'noul', noul: 0.96 },
        team: { type: 'choice', choice: 'billing', confidence: 0.84, probabilities: { billing: 0.84, shipping: 0.16 } },
        urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: { 0: 0, 1: 0.01, 2: 0.99 }, legend: {} }
      }
    }, questions)
    expect(out).toEqual({
      escalate: { type: 'predicate', probability: 0.96 },
      team: { type: 'choice', choice: 'billing', confidence: 0.84, probabilities: { billing: 0.84, shipping: 0.16 } },
      urgency: { type: 'score', score: 1.99, confidence: 0.99, probabilities: [0, 0.01, 0.99] }
    })
  })

  it('leaves out answers that are missing or malformed', () => {
    const out = fromOpenRouterDecisionResponse({ answers: { escalate: { noul: 'x' }, team: { choice: '' } } }, questions)
    expect(out).toEqual({})
  })
})

describe('fromTinfoilDecisionResponse', () => {
  it('maps predicate, choice and score answers by name', () => {
    const out = fromTinfoilDecisionResponse({
      model: 'decision-medium',
      answers: [
        { type: 'score', name: 'urgency', score: 0.981, confidence: 0.745, probabilities: [
          { value: 0, label: 'routine', probability: 0.137 },
          { value: 1, label: 'soon', probability: 0.745 },
          { value: 2, label: 'critical', probability: 0.118 }
        ] },
        { type: 'predicate', name: 'escalate', probability: 0.656 },
        { type: 'choice', name: 'team', choice: 'billing', confidence: 0.988, probabilities: [
          { value: 'billing', probability: 0.988 },
          { value: 'shipping', probability: 0.012 }
        ] }
      ],
      usage: { input_tokens: 350, output_tokens: 0, total_tokens: 350 }
    }, questions)
    expect(out).toEqual({
      escalate: { type: 'predicate', probability: 0.656 },
      team: { type: 'choice', choice: 'billing', confidence: 0.988, probabilities: { billing: 0.988, shipping: 0.012 } },
      urgency: { type: 'score', score: 0.981, confidence: 0.745, probabilities: [0.137, 0.745, 0.118] }
    })
  })

  it('returns nothing for a payload without answers', () => {
    expect(fromTinfoilDecisionResponse(null, questions)).toEqual({})
  })
})
