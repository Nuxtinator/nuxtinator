// Section markdown to HTML. Headings get GitHub-style ids so `#heading-text`
// links land on them; repeated headings get `-1`, `-2`, … suffixes.
import { Marked } from 'marked'

export function contextHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

export function renderContextSectionMarkdown(content: string): string {
  const seen = new Map<string, number>()
  const md = new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const base = contextHeadingSlug(this.parser.parseInline(tokens, this.parser.textRenderer))
        const n = seen.get(base) ?? 0
        seen.set(base, n + 1)
        const id = n === 0 ? base : `${base}-${n}`
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      }
    }
  })
  return md.parse(content, { async: false }) as string
}
