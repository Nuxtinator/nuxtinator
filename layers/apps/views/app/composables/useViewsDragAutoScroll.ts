// Scrolls a container while a drag hovers near its top or bottom edge, or past
// it, since a native drag doesn't let the wheel or trackpad scroll it.
import type { Ref } from 'vue'

const EDGE = 64
const MAX_SPEED = 1200
// dragover keeps firing while the pointer rests, so a long silence means the
// drag ended somewhere that never told this container.
const STALE_MS = 1000

export function useViewsDragAutoScroll(el: Ref<HTMLElement | null>) {
  let speed = 0
  let carry = 0
  let frame: number | null = null
  let lastFrame = 0
  let lastSeen = 0

  function stop() {
    speed = 0
    carry = 0
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  function tick(now: number) {
    const target = el.value
    if (!target || speed === 0 || now - lastSeen > STALE_MS) {
      stop()
      return
    }
    carry += speed * Math.min(now - lastFrame, 50) / 1000
    const step = Math.trunc(carry)
    if (step) {
      target.scrollTop += step
      carry -= step
    }
    lastFrame = now
    frame = requestAnimationFrame(tick)
  }

  /** Call on every dragover: sets the speed from how close the pointer is to an edge. */
  function update(event: DragEvent) {
    const target = el.value
    if (!target) return
    const rect = target.getBoundingClientRect()
    const edge = Math.min(EDGE, rect.height / 3)
    const fromTop = event.clientY - rect.top
    const fromBottom = rect.bottom - event.clientY
    if (fromTop < edge) speed = -MAX_SPEED * Math.min(1, (edge - fromTop) / edge)
    else if (fromBottom < edge) speed = MAX_SPEED * Math.min(1, (edge - fromBottom) / edge)
    else speed = 0
    lastSeen = performance.now()
    if (speed !== 0 && frame === null) {
      lastFrame = lastSeen
      frame = requestAnimationFrame(tick)
    }
  }

  onBeforeUnmount(stop)

  return { update, stop }
}
