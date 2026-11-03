// Naming usage subjects for the spend page. No Nuxt build needed.
import { describe, it, expect, beforeEach } from 'vitest'
import type { AiDbClient } from '#core/ai-fallback/types'
import { __resetAiUsageSubjectsForTests, registerAiUsageSubjects, usageSubjectLabels } from '../../server/utils/ai-usage-subjects'

const tx = {} as AiDbClient

describe('usageSubjectLabels', () => {
  beforeEach(() => {
    __resetAiUsageSubjectsForTests()
  })

  it('names ids through the prefix\'s resolver, one call per prefix', async () => {
    const asked: string[][] = []
    registerAiUsageSubjects({
      prefix: 'bots',
      label: 'Bot',
      resolve: async (_tx, ids) => {
        asked.push(ids)
        return new Map([['b1', 'Researcher']])
      }
    })
    const labels = await usageSubjectLabels(tx, ['bots:b1', 'bots:0123456789', 'bots:b1'])
    expect(asked).toEqual([['b1', '0123456789']])
    expect(labels.get('bots:b1')).toBe('Researcher')
    expect(labels.get('bots:0123456789')).toBe('Bot 01234567')
  })

  it('labels calls with no subject, and shows an unregistered subject as stored', async () => {
    const labels = await usageSubjectLabels(tx, ['', 'inbox:i1'])
    expect(labels.get('')).toBe('Not recorded')
    expect(labels.get('inbox:i1')).toBe('inbox:i1')
  })

  it('falls back to the prefix label when a resolver fails', async () => {
    registerAiUsageSubjects({ prefix: 'bots', label: 'Bot', resolve: () => Promise.reject(new Error('boom')) })
    const labels = await usageSubjectLabels(tx, ['bots:b1'])
    expect(labels.get('bots:b1')).toBe('Bot b1')
  })

  it('ignores a prefix containing a colon', async () => {
    registerAiUsageSubjects({ prefix: 'a:b', label: 'X', resolve: async () => new Map([['c', 'Named']]) })
    expect((await usageSubjectLabels(tx, ['a:b:c'])).get('a:b:c')).toBe('a:b:c')
  })
})
