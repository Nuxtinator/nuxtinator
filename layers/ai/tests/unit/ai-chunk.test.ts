// Pure-function coverage for the markdown chunker shared through #ai/server.
import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../../../core/ai-fallback/chunk'

describe('chunkMarkdown', () => {
  it('returns nothing for empty input', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('   \n\n')).toEqual([])
  })

  it('keeps a short document as one chunk with no heading', () => {
    const out = chunkMarkdown('Hello world.\n\nSecond paragraph.')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ordinal: 0, heading: '' })
    expect(out[0]!.text).toContain('Second paragraph.')
  })

  it('carries the nearest heading onto each chunk', () => {
    const md = '# Intro\n\nIntro text.\n\n## Install\n\nRun the installer.\n\n## Use\n\nClick things.'
    const out = chunkMarkdown(md, { maxChars: 200, overlapChars: 0 })
    expect(out.map(c => c.heading)).toEqual(['Intro', 'Install', 'Use'])
    expect(out[1]!.text).toBe('Run the installer.')
  })

  it('packs paragraphs up to maxChars and splits beyond it', () => {
    const para = 'word '.repeat(50).trim() // ~249 chars
    const md = Array.from({ length: 6 }, () => para).join('\n\n')
    const out = chunkMarkdown(md, { maxChars: 600, overlapChars: 0 })
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(600)
    expect(out.map(c => c.ordinal)).toEqual(out.map((_, i) => i))
  })

  it('hard-wraps a single oversized paragraph at sentence ends', () => {
    const md = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const out = chunkMarkdown(md, { maxChars: 300, overlapChars: 0 })
    expect(out.length).toBeGreaterThan(2)
    for (const c of out) {
      expect(c.text.length).toBeLessThanOrEqual(300)
      expect(c.text.endsWith('.')).toBe(true)
    }
  })

  it('prefixes each chunk with the tail of the previous one when overlapping', () => {
    const a = 'A'.repeat(180) + ' end of first.'
    const b = 'B'.repeat(180) + ' end of second.'
    const out = chunkMarkdown(`${a}\n\n${b}`, { maxChars: 200, overlapChars: 20 })
    expect(out).toHaveLength(2)
    expect(out[1]!.text.startsWith(a.slice(-20).trimStart())).toBe(true)
  })
})
