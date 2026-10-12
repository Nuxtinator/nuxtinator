// Pure coverage for page extraction: React streaming SSR and data tables.
import { describe, it, expect } from 'vitest'
import { helpinatorExtract } from '../../server/utils/helpinator-extract'

const PROSE = 'Select two to five models using the checkboxes in the table below to compare their performance across every benchmark category, with detailed side-by-side comparisons.'

function leaderboardRows(n: number): string {
  let rows = ''
  for (let i = 1; i <= n; i++) {
    rows += `<tr><td><button role="checkbox"></button><input type="checkbox"></td><td>${i}</td>`
      + `<td><a href="/providers/p${i}"><div><span>P</span></div>Provider ${i}</a></td>`
      + `<td><a href="/models/m${i}">Model ${i}</a></td>`
      + `<td><div><span>9${i}.5<!-- -->%</span></div></td><td><div style="width:90%"></div></td>`
      + `<td><a href="/models/m${i}"><svg></svg></a></td></tr>`
  }
  return rows
}

const TABLE_HEAD = '<thead><tr><th><button role="checkbox"></button></th><th>#</th><th>Provider</th>'
  + '<th><button>Model<svg></svg></button></th><th><button>Total Score</button></th><th></th><th></th></tr></thead>'

// The shape Next.js (App Router) streams: a skeleton inside the Suspense
// boundary in <main>, the real content in a hidden div after it, and the
// inline $RC call that swaps them in a browser.
function streamedPage(rows: number): string {
  return `<!doctype html><html><head><title>Leaderboard | Bench</title></head><body>
    <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
    <main><!--$?--><template id="B:0"></template><div class="skeleton"><div></div><div></div></div><!--/$--></main>
    <footer><p>Disclaimer: this benchmark is for information only and endorses no model or service whatsoever, now or later.</p></footer>
    <div hidden id="S:0"><div class="container">
      <div><h1>Leaderboard</h1><p>Compare AI models and explore benchmark results.</p></div>
      <div class="card"><h3>Compare Models Side-by-Side</h3><p>${PROSE}</p></div>
      <div class="card"><div class="title">Model Rankings</div><div class="px-5"><div class="rounded-lg border"><div class="overflow-x-auto">
        <table>${TABLE_HEAD}<tbody>${leaderboardRows(rows)}</tbody></table>
      </div></div></div></div>
    </div></div>
    <script>$RC("B:0","S:0")</script>
  </body></html>`
}

describe('helpinatorExtract — React streaming', () => {
  it('swaps streamed boundary content in place of the skeleton', () => {
    const { markdown, title } = helpinatorExtract(streamedPage(5), 'https://bench.test/leaderboard')
    expect(title).toBeTruthy()
    expect(markdown).not.toContain('skeleton')
    expect(markdown).toContain(PROSE)
    expect(markdown).not.toContain('Disclaimer')
  })

  it('replaces a completed segment placeholder', () => {
    const html = `<html><body><main><h1>Docs</h1><template id="P:1"></template></main>
      <div hidden id="S:1"><p>${PROSE} This paragraph arrived as a streamed segment.</p></div></body></html>`
    expect(helpinatorExtract(html, 'https://bench.test/docs').markdown).toContain('arrived as a streamed segment')
  })

  it('keeps nested boundaries intact when dropping a fallback', () => {
    const html = `<html><body><main><!--$?--><template id="B:0"></template><div>loading <!--$--><span>inner</span><!--/$--></div><!--/$--><p>After the boundary. ${PROSE}</p></main>
      <div hidden id="S:0"><p>Streamed. ${PROSE}</p></div></body></html>`
    const { markdown } = helpinatorExtract(html, 'https://bench.test/')
    expect(markdown).toContain('Streamed.')
    expect(markdown).toContain('After the boundary.')
    expect(markdown).not.toContain('loading')
  })
})

describe('helpinatorExtract — tables', () => {
  it('falls back to the whole page when readability drops the data table', () => {
    const { markdown } = helpinatorExtract(streamedPage(5), 'https://bench.test/leaderboard')
    for (let i = 1; i <= 5; i++) expect(markdown).toContain(`Model: [Model ${i}](https://bench.test/models/m${i})`)
  })

  it('writes one labelled line per row, links kept, empty cells and icon links skipped', () => {
    const { markdown } = helpinatorExtract(streamedPage(3), 'https://bench.test/leaderboard')
    expect(markdown).toContain('- #: 1 · Provider: [P Provider 1](https://bench.test/providers/p1) · Model: [Model 1](https://bench.test/models/m1) · Total Score: 91.5%\n')
  })

  it('labels spanned columns and leaves blank-header values unlabelled', () => {
    const html = `<html><body><main><h1>Prices</h1><p>${PROSE}</p><table>
      <tr><th>Plan</th><th colspan="2">Price</th><th></th></tr>
      <tr><td>Basic</td><td colspan="2">$5</td><td>popular</td></tr>
      <tr><td>Pro</td><td>$10</td><td>$100/yr</td><td></td></tr>
      <tr><td>Team</td><td>$20</td><td>$200/yr</td><td>new</td></tr>
    </table></main></body></html>`
    const { markdown } = helpinatorExtract(html, 'https://bench.test/prices')
    expect(markdown).toContain('- Plan: Basic · Price: $5 · popular')
    expect(markdown).toContain('- Plan: Pro · Price: $10 · Price: $100/yr\n')
    expect(markdown).toContain('- Plan: Team · Price: $20 · Price: $200/yr · new')
  })

  it('joins cells of a headerless table without labels', () => {
    const html = `<html><body><main><h1>Contact</h1><p>${PROSE}</p><table>
      <tr><td>Phone</td><td>555 0100</td></tr>
      <tr><td>Email</td><td><a href="mailto:hi@bench.test">hi@bench.test</a></td></tr>
      <tr><td>Hours</td><td>9 to 5</td></tr>
    </table></main></body></html>`
    const { markdown } = helpinatorExtract(html, 'https://bench.test/contact')
    expect(markdown).toContain('- Phone · 555 0100')
    expect(markdown).toContain('- Email · [hi@bench.test](mailto:hi@bench.test)')
  })
})

describe('helpinatorExtract — links', () => {
  const page = (head: string, body: string) => `<html><head>${head}</head><body><main><h1>Docs</h1><p>${PROSE}</p>${body}</main></body></html>`

  it('makes relative links and images absolute against the page URL', () => {
    const { markdown } = helpinatorExtract(page('', `<p>See <a href="../guide?x=1">the guide</a>, <a href="/faq">the FAQ</a> and <img src="img/a.png" alt="A"></p>`), 'https://bench.test/docs/start')
    expect(markdown).toContain('[the guide](https://bench.test/guide?x=1)')
    expect(markdown).toContain('[the FAQ](https://bench.test/faq)')
    expect(markdown).toContain('![A](https://bench.test/docs/img/a.png)')
  })

  it('honours <base href>', () => {
    const { markdown } = helpinatorExtract(page('<base href="https://cdn.bench.test/v2/">', `<p><a href="intro">Intro</a></p>`), 'https://bench.test/docs/')
    expect(markdown).toContain('[Intro](https://cdn.bench.test/v2/intro)')
  })

  it('leaves anchors, mailto: and absolute links alone', () => {
    const { markdown } = helpinatorExtract(page('', `<p><a href="#top">Top</a> <a href="mailto:hi@bench.test">Mail</a> <a href="https://other.test/x">Other</a></p>`), 'https://bench.test/docs/')
    expect(markdown).toContain('[Top](#top)')
    expect(markdown).toContain('[Mail](mailto:hi@bench.test)')
    expect(markdown).toContain('[Other](https://other.test/x)')
  })
})
