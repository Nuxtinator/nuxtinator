// Pure-function coverage for the addressing grammar and the inbound parsing
// helpers (auth verdicts, auto-responder detection).
import { describe, it, expect } from 'vitest'
import {
  inboxParseRecipient,
  inboxIsBounceRecipient,
  inboxBuildReplyAddress,
  inboxBuildFromAddress
} from '../../server/utils/inbox-addressing'
import {
  type InboxInboundHeaders,
  inboxExtractEmailAddress,
  inboxExtractDisplayName,
  inboxParseAuthentication,
  inboxIsAutoResponderOrBounce,
  inboxIsVacationAutoReply
} from '../../server/utils/inbox-inbound-parse'
import { inboxConstrainImages } from '../../server/utils/inbox-email-shell'
import { inboxStripQuotedHtml, inboxStripQuotedText } from '../../server/utils/inbox-sanitize'
import { inboxSniffImageMime, inboxIsInlineImageKey, inboxInlineMimeForKey } from '../../server/utils/inbox-inline-images'

function headers(pairs: [string, string][]): InboxInboundHeaders {
  const all = (name: string) => pairs.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v)
  return { get: name => all(name)[0] ?? null, getAll: all }
}

describe('inbox addressing', () => {
  it('parses plain, token, and future signed-shape recipients', () => {
    expect(inboxParseRecipient('contact@x.test')).toMatchObject({ base: 'contact', token: null, domain: 'x.test' })
    expect(inboxParseRecipient('contact+ab12@x.test')).toMatchObject({ base: 'contact', token: 'ab12' })
    // Signed staff addresses (token.exp.sig) parse today; only the token is used.
    expect(inboxParseRecipient('contact+ab12.k3.f00d@x.test')).toMatchObject({ token: 'ab12' })
    expect(inboxParseRecipient('"Someone" <Contact+AB12@X.TEST>')).toMatchObject({ token: 'ab12', domain: 'x.test' })
    expect(inboxParseRecipient('not-an-email')).toBeNull()
  })

  it('flags the VERP bounce return-path', () => {
    expect(inboxIsBounceRecipient(inboxParseRecipient('bounce@x.test'))).toBe(true)
    expect(inboxIsBounceRecipient(inboxParseRecipient('bounce+verp@x.test'))).toBe(true)
    expect(inboxIsBounceRecipient(inboxParseRecipient('contact@x.test'))).toBe(false)
  })

  it('builds reply and From addresses', () => {
    expect(inboxBuildReplyAddress('tok', 'contact@x.test')).toBe('contact+tok@x.test')
    expect(inboxBuildFromAddress({ displayName: 'Jane', contactAddress: 'contact@x.test' }))
      .toBe('"Jane" <contact@x.test>')
    expect(inboxBuildFromAddress({ contactAddress: 'contact@x.test' })).toBe('contact@x.test')
  })
})

describe('inbound parsing', () => {
  it('extracts addresses and display names', () => {
    expect(inboxExtractEmailAddress('Jane Doe <JANE@X.TEST>')).toBe('jane@x.test')
    expect(inboxExtractDisplayName('"Jane Doe" <jane@x.test>')).toBe('Jane Doe')
    expect(inboxExtractDisplayName('jane@x.test')).toBeNull()
  })

  it('authenticates on dmarc pass or aligned dkim, never on misaligned dkim', () => {
    const h = (ar: string) => headers([['Authentication-Results', ar]])
    expect(inboxParseAuthentication(h('mx; dmarc=pass'), 'a@gmail.com').authenticated).toBe(true)
    expect(inboxParseAuthentication(h('mx; dkim=pass header.d=gmail.com'), 'a@gmail.com').authenticated).toBe(true)
    expect(inboxParseAuthentication(h('mx; dkim=pass header.d=evil.example'), 'a@gmail.com').authenticated).toBe(false)
    expect(inboxParseAuthentication(h('mx; dkim=fail; dmarc=fail'), 'a@gmail.com').authenticated).toBe(false)
    expect(inboxParseAuthentication(headers([]), 'a@gmail.com').authenticated).toBe(false)
  })

  it('detects auto-responders and the vacation subset', () => {
    const auto = headers([['Auto-Submitted', 'auto-replied']])
    const bounce = headers([['Auto-Submitted', 'auto-generated']])
    const human = headers([])

    expect(inboxIsAutoResponderOrBounce(auto, 'a@x.test')).toBe(true)
    expect(inboxIsVacationAutoReply(auto, 'a@x.test')).toBe(true)
    // DSN/bounce style is an auto-responder but NOT a vacation reply.
    expect(inboxIsAutoResponderOrBounce(bounce, 'a@x.test')).toBe(true)
    expect(inboxIsVacationAutoReply(bounce, 'a@x.test')).toBe(false)
    expect(inboxIsAutoResponderOrBounce(human, 'mailer-daemon@x.test')).toBe(true)
    expect(inboxIsVacationAutoReply(human, 'mailer-daemon@x.test')).toBe(false)
    expect(inboxIsAutoResponderOrBounce(human, 'a@x.test')).toBe(false)
  })
})

describe('quoted history stripping', () => {
  it('drops blockquotes and client quote containers from html', () => {
    expect(inboxStripQuotedHtml('<p>Thanks!</p><div class="gmail_quote">On Mon <blockquote>old</blockquote></div>'))
      .toBe('<p>Thanks!</p>')
    expect(inboxStripQuotedHtml('<p>New</p><blockquote type="cite"><p>old</p></blockquote>')).toBe('<p>New</p>')
    expect(inboxStripQuotedHtml('<blockquote>only quotes</blockquote>')).toBe('')
  })

  it('cuts plain text at the quote', () => {
    expect(inboxStripQuotedText('Sounds good.\n\nOn Mon, Jan 1, Jane wrote:\n> old')).toBe('Sounds good.')
    expect(inboxStripQuotedText('Yes\n> earlier')).toBe('Yes')
    expect(inboxStripQuotedText('> all quoted')).toBe('> all quoted')
  })
})

describe('outbound image constraining', () => {
  const CAP = 'max-width:100%;max-height:480px;height:auto;'

  it('adds a size cap to a bare img', () => {
    expect(inboxConstrainImages('<img src="x.png">')).toBe(`<img src="x.png" style="${CAP}">`)
  })

  it('appends the cap LAST inside an existing style, both quote styles', () => {
    expect(inboxConstrainImages('<img src="x.png" style="width:900px">'))
      .toBe(`<img src="x.png" style="width:900px;${CAP}">`)
    expect(inboxConstrainImages("<img style='color:red' src='x.png'>"))
      .toBe(`<img style='color:red;${CAP}' src='x.png'>`)
  })

  it('preserves a self-closing tag', () => {
    expect(inboxConstrainImages('<img src="x.png" />')).toBe(`<img src="x.png" style="${CAP}" />`)
  })

  it('constrains every img (e.g. quoted history) and leaves non-img HTML alone', () => {
    const out = inboxConstrainImages('<p>hi</p><img src="a.png"><br><img src="b.png">')
    expect(out).toBe(`<p>hi</p><img src="a.png" style="${CAP}"><br><img src="b.png" style="${CAP}">`)
  })
})

describe('inline image sniffing', () => {
  it('accepts the four image types by magic bytes, rejects non-images and shorts', () => {
    expect(inboxSniffImageMime(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]))).toBe('image/png')
    expect(inboxSniffImageMime(new Uint8Array([0xFF, 0xD8, 0xFF, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe('image/jpeg')
    expect(inboxSniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6]))).toBe('image/gif')
    expect(inboxSniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    // "<!DOCTYPE ht" — a .png-named HTML/SVG payload must not sniff as an image.
    expect(inboxSniffImageMime(new TextEncoder().encode('<!DOCTYPE ht'))).toBeNull()
    expect(inboxSniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('validates inline-image keys (prefix + no traversal) and derives mime', () => {
    expect(inboxIsInlineImageKey('inbox-inline/org/abc.png')).toBe(true)
    expect(inboxIsInlineImageKey('inbox/raw-x.eml')).toBe(false)
    expect(inboxIsInlineImageKey('inbox-inline/../secret')).toBe(false)
    expect(inboxInlineMimeForKey('inbox-inline/org/abc.webp')).toBe('image/webp')
    expect(inboxInlineMimeForKey('inbox-inline/org/abc.eml')).toBeNull()
  })
})
