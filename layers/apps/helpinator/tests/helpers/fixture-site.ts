// A tiny in-process website for crawl tests. The booted Nuxt host fetches it
// over loopback like any other site. Pages are mutable per test so a
// re-crawl can see content change or a page vanish.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FixturePage {
  html: string
  contentType?: string
  // Answer with this status (default 200).
  status?: number
  // 302 to this location instead of serving `html`.
  redirect?: string
  // Stream `html` repeated until this many bytes, chunked (no content-length).
  streamBytes?: number
  // Wait this long before answering.
  delayMs?: number
}

export interface FixtureSite {
  origin: string
  pages: Map<string, FixturePage>
  hits: string[]
  close: () => Promise<void>
}

const LONG = (topic: string) => Array.from({ length: 4 }, (_, i) =>
  `<p>${topic} paragraph ${i + 1}. This article explains ${topic} in enough detail for a readability parser to treat it as the main content of the page, with several sentences of prose so that the character threshold is comfortably exceeded.</p>`
).join('\n')

export function article(title: string, topic: string, extra = ''): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/pricing">Pricing</a></nav>
<main><article><h1>${title}</h1>${LONG(topic)}${extra}</article></main>
<footer><a href="/contact">Contact</a></footer>
</body></html>`
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const pages = new Map<string, FixturePage>()
  const hits: string[] = []
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]!
    hits.push(path)
    const delayMs = pages.get(path)?.delayMs
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('User-agent: *\nDisallow: /docs/secret\n')
      return
    }
    const page = pages.get(path)
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html><body>nope</body></html>')
      return
    }
    if (page.redirect) {
      res.writeHead(302, { location: page.redirect })
      res.end()
      return
    }
    res.writeHead(page.status ?? 200, { 'content-type': page.contentType ?? 'text/html; charset=utf-8' })
    if (page.streamBytes) {
      const chunk = Buffer.from(page.html.repeat(Math.ceil(65536 / page.html.length)))
      let sent = 0
      const pump = () => {
        while (sent < page.streamBytes!) {
          sent += chunk.length
          if (!res.write(chunk)) return void res.once('drain', pump)
        }
        res.end()
      }
      res.on('error', () => {})
      req.socket.on('close', () => { sent = page.streamBytes! })
      pump()
      return
    }
    res.end(page.html)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    pages,
    hits,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  }
}

// The default docs tree: an index under /docs linking two articles, one page
// outside the path, one off-site link, one PDF, one robots-disallowed page.
export function seedDocsTree(site: FixtureSite): void {
  site.pages.set('/docs', {
    html: `<!doctype html><html><head><title>Docs</title></head><body><main>
<h1>Documentation</h1><p>Welcome to the documentation index, which lists every guide we publish for the product and links to each one below.</p>
<ul>
<li><a href="/docs/anvils">Anvils</a></li>
<li><a href="/docs/horseshoes?utm_source=x#top">Horseshoes</a></li>
<li><a href="/docs/secret">Secret</a></li>
<li><a href="/pricing">Pricing</a></li>
<li><a href="https://example.com/elsewhere">Elsewhere</a></li>
<li><a href="/docs/manual.pdf">Manual (PDF)</a></li>
<li><a href="mailto:x@example.com">Mail</a></li>
</ul></main></body></html>`
  })
  site.pages.set('/docs/anvils', { html: article('Anvils', 'anvil forging') })
  site.pages.set('/docs/horseshoes', { html: article('Horseshoes', 'horseshoe fitting') })
  site.pages.set('/docs/secret', { html: article('Secret', 'secret recipes') })
  site.pages.set('/pricing', { html: article('Pricing', 'pricing plans') })
  site.pages.set('/docs/manual.pdf', { html: '%PDF-1.4', contentType: 'application/pdf' })
  site.pages.set('/', {
    html: `<!doctype html><html><head><title>Home</title></head><body><main><h1>Home</h1><p>The home page of the fixture site, which links to the documentation and to the pricing page for visitors who want to compare plans before they buy.</p><a href="/docs/anvils">Anvils</a> <a href="/pricing">Pricing</a></main></body></html>`
  })
}
