// Page extraction for the crawler: a fetched page's main content as markdown.
// Pure (no DB, no network) so it is unit-tested on its own.
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

// The slice of the DOM the crawler touches. linkedom's parseHTML is typed
// loosely and the nitro tsconfig has no DOM lib, so the document is cast to
// this once at each parse site.
export interface HelpinatorDomNode {
  nodeType: number
  nodeName: string
  textContent: string | null
  innerHTML: string
  id: string
  childNodes: ArrayLike<HelpinatorDomNode>
  firstChild: HelpinatorDomNode | null
  nextSibling: HelpinatorDomNode | null
  parentNode: HelpinatorDomNode | null
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  remove(): void
  insertBefore(node: HelpinatorDomNode, ref: HelpinatorDomNode | null): void
  querySelector(sel: string): HelpinatorDomNode | null
  querySelectorAll(sel: string): Iterable<HelpinatorDomNode>
  closest(sel: string): HelpinatorDomNode | null
  cloneNode(deep: boolean): HelpinatorDomNode
}
export interface HelpinatorDomDocument extends HelpinatorDomNode {
  body: HelpinatorDomNode | null
  getElementById(id: string): HelpinatorDomNode | null
}
export function helpinatorParseDom(html: string): HelpinatorDomDocument {
  return (parseHTML(html) as unknown as { document: HelpinatorDomDocument }).document
}

export interface HelpinatorExtracted {
  title: string
  markdown: string
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8

// --- React streaming SSR ---

// React streams a Suspense boundary's content after the shell: the boundary
// holds `<!--$?--><template id="B:n"></template>…fallback…<!--/$-->`, the
// real content arrives later as `<div hidden id="S:n">`, and an inline
// `$RC("B:n","S:n")` script swaps it in. A completed segment uses
// `<template id="P:n">` instead, replaced as-is. Without JS the page shows
// only the fallback (a skeleton), and readability skips the hidden div. This
// does the swap on the parsed document, the way `$RC` / `$RS` do.
function resolveReactStreaming(document: HelpinatorDomDocument): void {
  for (;;) {
    let moved = false
    for (const segment of Array.from(document.querySelectorAll('div[hidden][id^="S:"]'))) {
      const n = segment.id.slice(2)
      const boundary = document.getElementById(`B:${n}`)
      const placeholder = boundary ?? document.getElementById(`P:${n}`)
      const parent = placeholder?.parentNode
      if (!placeholder || !parent) continue
      // A boundary drops its fallback up to the matching `<!--/$-->`; a
      // segment placeholder is the only node to replace.
      let end: HelpinatorDomNode | null = placeholder.nextSibling
      if (boundary) {
        let depth = 0
        while (end) {
          if (end.nodeType === COMMENT_NODE) {
            const data = end.textContent
            if (data === '/$') {
              if (depth === 0) break
              depth--
            } else if (data === '$' || data === '$?' || data === '$!') {
              depth++
            }
          }
          const next: HelpinatorDomNode | null = end.nextSibling
          end.remove()
          end = next
        }
      }
      while (segment.firstChild) parent.insertBefore(segment.firstChild, end)
      placeholder.remove()
      segment.remove()
      moved = true
    }
    // Segments can carry placeholders for later segments; repeat until done.
    if (!moved) break
  }
}

// --- Tables ---

// A data table becomes one line per row with the column names inline
// ("Model: X · Score: 90%"), so each row still reads on its own once the
// page is chunked away from its header row.
const SKIP_IN_CELL = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'INPUT', 'SELECT', 'TEXTAREA'])
const BLOCK_IN_CELL = new Set(['DIV', 'P', 'BR', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TR', 'TD', 'TH', 'SECTION', 'HEADER', 'FOOTER'])

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// A cell's text, with a space at block boundaries (an avatar `<div>M</div>`
// next to a name must not run into it) and links kept as markdown.
function cellText(node: HelpinatorDomNode): string {
  let out = ''
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      out += child.textContent ?? ''
      continue
    }
    if (child.nodeType !== ELEMENT_NODE) continue
    const tag = child.nodeName.toUpperCase()
    if (SKIP_IN_CELL.has(tag)) continue
    const inner = cellText(child)
    const block = BLOCK_IN_CELL.has(tag)
    if (block) out += ' '
    if (tag === 'A') {
      const text = squash(inner)
      const href = child.getAttribute('href')
      if (text) out += href && !/^(javascript|#)/i.test(href) ? `[${text}](${href})` : text
    } else {
      out += inner
    }
    if (block) out += ' '
  }
  return out
}

function rowCells(row: HelpinatorDomNode): { text: string, span: number }[] {
  return Array.from(row.childNodes)
    .filter(c => c.nodeType === ELEMENT_NODE && /^T[DH]$/i.test(c.nodeName))
    .map(c => ({ text: squash(cellText(c)), span: Math.max(1, Number(c.getAttribute('colspan')) || 1) }))
}

// Rows of this table only, not of tables nested inside it.
function ownRows(table: HelpinatorDomNode): HelpinatorDomNode[] {
  return Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table)
}

function isHeaderRow(row: HelpinatorDomNode): boolean {
  if (row.closest('thead')) return true
  const cells = Array.from(row.childNodes).filter(c => c.nodeType === ELEMENT_NODE && /^T[DH]$/i.test(c.nodeName))
  return cells.length > 0 && cells.every(c => /^TH$/i.test(c.nodeName))
}

function tableToMarkdown(table: HelpinatorDomNode): string {
  const rows = ownRows(table)
  // The last header row names the columns; spanned headers cover each column.
  let headers: string[] | null = null
  const lines: string[] = []
  for (const row of rows) {
    const cells = rowCells(row)
    if (!lines.length && isHeaderRow(row)) {
      headers = cells.flatMap(c => Array(c.span).fill(c.text) as string[])
      continue
    }
    const parts: string[] = []
    let col = 0
    for (const cell of cells) {
      const label = headers?.[col]
      col += cell.span
      if (!cell.text) continue
      parts.push(label ? `${label}: ${cell.text}` : cell.text)
    }
    if (parts.length) lines.push(`- ${parts.join(' · ')}`)
  }
  const caption = squash(table.querySelector('caption')?.textContent ?? '')
  const body = lines.join('\n')
  return caption ? `${caption}\n\n${body}` : body
}

// Sortable column headers put their label in a <button>, which readability
// and turndown both drop. Unwrap them so the header keeps its text.
function unwrapHeaderButtons(document: HelpinatorDomDocument): void {
  for (const button of Array.from(document.querySelectorAll('th button'))) {
    const parent = button.parentNode
    if (!parent) continue
    while (button.firstChild) parent.insertBefore(button.firstChild, button)
    button.remove()
  }
}

// A table with this many data rows is page content worth keeping: when
// readability drops one, the whole-page fallback is used instead.
const CONTENT_TABLE_MIN_ROWS = 3
function hasContentTable(root: HelpinatorDomNode): boolean {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (ownRows(table).filter(r => !isHeaderRow(r)).length >= CONTENT_TABLE_MIN_ROWS) return true
  }
  return false
}

// --- Links ---

// Relative links and image sources are made absolute against the page (or its
// `<base href>`), so the bot can hand a visitor a link that works. In-page
// `#` anchors and non-http schemes (mailto:, tel:, javascript:) are left as-is.
function absolutizeLinks(document: HelpinatorDomDocument, pageUrl: string): void {
  let base: URL
  try {
    base = new URL(pageUrl)
    const declared = document.querySelector('base[href]')?.getAttribute('href')
    if (declared) base = new URL(declared, base)
  } catch {
    return
  }
  for (const [sel, attr] of [['a[href]', 'href'], ['img[src]', 'src']] as const) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const value = (el.getAttribute(attr) ?? '').trim()
      if (!value || value.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(value)) continue
      try {
        const abs = new URL(value, base)
        if (abs.protocol === 'http:' || abs.protocol === 'https:') el.setAttribute(attr, abs.toString())
      } catch {
        // Unparseable: leave it.
      }
    }
  }
}

// --- Extraction ---

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button', 'time'] as never)
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => `\n\n${tableToMarkdown(node as unknown as HelpinatorDomNode)}\n\n`
})

function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Share of an element's text that sits inside links. Menus are near 1.
function linkDensity(el: HelpinatorDomNode): number {
  const total = (el.textContent ?? '').replace(/\s+/g, '').length
  if (!total) return 0
  let linked = 0
  for (const a of Array.from(el.querySelectorAll('a'))) linked += (a.textContent ?? '').replace(/\s+/g, '').length
  return linked / total
}

// A site menu, as opposed to a listing page's content: mostly links, 5 or
// more of them, with short labels ("About", "Contact us"). Listing entries
// read as titles or sentences, so they average more words per link. Anything
// inside (or wrapping) the page's main content is never a menu.
const MENU_MIN_LINKS = 5
const MENU_MAX_WORDS_PER_LINK = 4
function looksLikeMenu(el: HelpinatorDomNode): boolean {
  if (el.closest('main, article') || el.querySelector('main, article')) return false
  const links = Array.from(el.querySelectorAll('a'))
  if (links.length < MENU_MIN_LINKS || linkDensity(el) <= 0.8) return false
  const words = links.reduce((n, a) => n + (a.textContent ?? '').trim().split(/\s+/).filter(Boolean).length, 0)
  return words / links.length <= MENU_MAX_WORDS_PER_LINK
}

// Readability picks the main article; the fallback is the whole body with
// chrome elements stripped, for pages readability rejects (short listings).
// Readability can return just a site menu: on Elementor pages it picks the
// page-wide wrapper, then drops the content blocks because their class says
// "widget". A pick that is mostly links is treated as a rejection. So is a
// pick that leaves out the page's data table — readability scores prose, so
// a leaderboard or price list loses to the blurb above it.
export function helpinatorExtract(html: string, url: string): HelpinatorExtracted {
  return helpinatorExtractFrom(helpinatorParseDom(html), url)
}

// The same, on an already-parsed document (the crawler reads its links from
// the same parse first). Mutates the document.
export function helpinatorExtractFrom(document: HelpinatorDomDocument, url: string): HelpinatorExtracted {
  resolveReactStreaming(document)
  absolutizeLinks(document, url)
  unwrapHeaderButtons(document)
  const docTitle = (document.querySelector('title')?.textContent ?? '').trim()
  for (const el of Array.from(document.querySelectorAll('time'))) el.remove()

  let article: { title?: string | null, content?: string | null } | null
  try {
    // Readability mutates the document; work on a clone for the fallback.
    article = new Readability(document.cloneNode(true) as never, { charThreshold: 100 }).parse()
  } catch {
    article = null
  }

  let contentHtml = article?.content ?? ''
  if (contentHtml.trim()) {
    const picked = helpinatorParseDom(`<html><body>${contentHtml}</body></html>`).body!
    if (linkDensity(picked) > 0.5) contentHtml = ''
    else if (!hasContentTable(picked) && hasContentTable(document)) contentHtml = ''
  }
  if (!contentHtml.trim()) {
    for (const sel of ['nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]']) {
      for (const el of Array.from(document.querySelectorAll(sel))) el.remove()
    }
    // Menus not marked up as <nav>: short-label link lists, and the blocks
    // wrapping them.
    for (const el of Array.from(document.querySelectorAll('ul, ol, div'))) {
      if (looksLikeMenu(el)) el.remove()
    }
    contentHtml = (document.querySelector('main') ?? document.body)?.innerHTML ?? ''
  }
  const markdown = cleanMarkdown(turndown.turndown(contentHtml))
  const h1 = (document.querySelector('h1')?.textContent ?? '').trim()
  const title = (article?.title ?? '').trim() || h1 || docTitle || url
  return { title: title.slice(0, 300), markdown }
}
