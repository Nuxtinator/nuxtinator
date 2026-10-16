// Section markdown gives headings GitHub-style ids so in-page links resolve.
import { describe, it, expect } from 'vitest'
import { renderContextSectionMarkdown } from '../../app/utils/section-markdown'

describe('renderContextSectionMarkdown', () => {
  it('gives headings slug ids from their text, ignoring inline markup', () => {
    const html = renderContextSectionMarkdown('## **Production Standards**\n\n### Tom & Jerry\'s `code`')
    expect(html).toContain('<h2 id="production-standards"><strong>Production Standards</strong></h2>')
    expect(html).toContain('<h3 id="tom--jerrys-code">')
  })

  it('suffixes repeated headings', () => {
    const html = renderContextSectionMarkdown('# Notes\n\n## Notes\n\n## Notes')
    expect([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])).toEqual(['notes', 'notes-1', 'notes-2'])
  })

  it('keeps non-latin letters', () => {
    expect(renderContextSectionMarkdown('# Café Ünï')).toContain('id="café-ünï"')
  })
})
