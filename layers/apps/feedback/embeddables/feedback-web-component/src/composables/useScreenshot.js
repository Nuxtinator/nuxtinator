/**
 * useScreenshot — captures the currently visible viewport of the host page as a
 * PNG Blob using html2canvas-pro.
 *
 * The capture is cropped to the visible viewport (x/y/width/height below) rather
 * than the full scrollable page, so the result matches what the user can see.
 *
 * The widget itself lives in the host page's light DOM under
 * `.feedback-widget-slot` (the visible bubble + panel) plus a
 * `<feedback-web-component>` custom element host. Both are skipped via
 * `ignoreElements` so the screenshot does not include the feedback panel.
 */

export function useScreenshot() {
  async function capture() {
    const { default: html2canvas } = await import('html2canvas-pro')
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const canvas = await html2canvas(document.documentElement, {
      // Crop to the visible viewport: offset into the page by the current
      // scroll position, sized to the inner window box.
      x: scrollX,
      y: scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      onclone: clonedDoc => {
        // html2canvas derives element positions from clientRect + this scroll offset,
        // so the clone has to really sit there. A host page's `scroll-behavior: smooth`
        // is inherited by the clone and would animate the jump instead of applying it.
        const style = clonedDoc.createElement('style')
        style.textContent = '*{scroll-behavior:auto !important}'
        clonedDoc.head.appendChild(style)
        clonedDoc.defaultView?.scrollTo(scrollX, scrollY)
        patchUnsupportedStyles(clonedDoc)
      },
      ignoreElements: el =>
        (el.classList && el.classList.contains('feedback-widget-slot')) ||
        el.tagName === 'FEEDBACK-WEB-COMPONENT',
      useCORS: true,
      logging: false,
      backgroundColor: null
    })
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  }
  return { capture }
}

const SKIP_INPUT_TYPES = new Set(['checkbox', 'radio', 'hidden', 'range', 'color', 'file', 'image'])

// Rewrites styles html2canvas draws wrong into equivalents it draws right:
// mask-image icons (Iconify/Nuxt UI) paint as solid squares, inset rings
// (Tailwind `ring-inset`) paint as thick borders, and input text lands too low.
function patchUnsupportedStyles(doc) {
  const win = doc.defaultView
  if (!win) return
  const toRgba = colorNormalizer(doc)

  for (const el of doc.body.querySelectorAll('*')) {
    const cs = win.getComputedStyle(el)
    maskIconToBackground(el, cs, toRgba)
    insetRingToBorder(el, cs, toRgba)
  }

  for (const el of doc.body.querySelectorAll('input')) {
    if (SKIP_INPUT_TYPES.has(el.type)) continue
    const cs = win.getComputedStyle(el)
    const box = doc.createElement('div')
    for (const prop of cs) box.style.setProperty(prop, cs.getPropertyValue(prop))
    box.style.setProperty('white-space', 'pre')
    box.style.setProperty('overflow', 'hidden')
    box.textContent = el.type === 'password' && el.value
      ? '•'.repeat(el.value.length)
      : el.value || el.placeholder || ''
    if (!el.value) box.style.setProperty('color', win.getComputedStyle(el, '::placeholder').color)
    el.replaceWith(box)
  }
}

// An icon drawn as `mask-image: url(svg)` over `background-color: currentColor`
// becomes the same SVG, recoloured, as a background image.
function maskIconToBackground(el, cs, toRgba) {
  const mask = [cs.maskImage, cs.webkitMaskImage].find(v => v && v !== 'none') || ''
  const match = mask.match(/^url\("?(data:image\/svg\+xml[^")]*)"?\)$/)
  if (!match) return
  const uri = match[1]
  const comma = uri.indexOf(',')
  let svg = uri.slice(0, comma).includes(';base64')
    ? atob(uri.slice(comma + 1))
    : decodeURIComponent(uri.slice(comma + 1))
  const paint = toRgba(cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : cs.color)
  svg = svg.replace(/(fill|stroke)=(['"])(black|#000|#000000|currentColor)\2/gi, `$1=$2${paint}$2`)
  const set = (prop, value) => el.style.setProperty(prop, value, 'important')
  set('background-image', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
  set('background-size', cs.maskSize || '100% 100%')
  set('background-repeat', cs.maskRepeat || 'no-repeat')
  set('background-position', cs.maskPosition || 'center')
  set('background-color', 'transparent')
  set('mask-image', 'none')
  set('-webkit-mask-image', 'none')
}

// A `0 0 0 Npx inset` shadow becomes an N px border, taken out of the padding
// so the element keeps its size and its content stays put.
function insetRingToBorder(el, cs, toRgba) {
  if (!cs.boxShadow?.includes('inset') || parseFloat(cs.borderTopWidth)) return
  const keep = []
  let ring = null
  for (const shadow of splitTopLevel(cs.boxShadow)) {
    const lengths = (shadow.match(/-?[\d.]+px/g) || []).map(parseFloat)
    const [x, y, blur, spread] = lengths
    if (/\binset\b/.test(shadow) && lengths.length === 4 && !x && !y && !blur && spread > 0) {
      const color = shadow.replace(/\binset\b/, '').replace(/-?[\d.]+px/g, '').trim()
      if (!ring || spread > ring.width) ring = { width: spread, color }
    } else {
      keep.push(shadow)
    }
  }
  if (!ring) return
  const set = (prop, value) => el.style.setProperty(prop, value, 'important')
  set('box-shadow', keep.length ? keep.join(', ') : 'none')
  set('border', `${ring.width}px solid ${toRgba(ring.color)}`)
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const padding = parseFloat(cs.getPropertyValue(`padding-${side}`)) || 0
    set(`padding-${side}`, `${Math.max(0, padding - ring.width)}px`)
  }
}

// Any CSS colour (oklch, color-mix, …) → rgba(), via a 1px canvas.
function colorNormalizer(doc) {
  const ctx = doc.createElement('canvas').getContext('2d', { willReadFrequently: true })
  return color => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`
  }
}

// Splits a comma list (e.g. box-shadow) on commas outside parentheses.
function splitTopLevel(value) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && !depth) {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
