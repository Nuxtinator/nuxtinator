// Browser cache of the visitor's conversation, keyed per widget. Only a
// display copy so a refresh doesn't lose the chat — the server holds the real
// transcript and wins on restore. Every access is guarded: storage can be
// blocked (private mode, cookie settings) and the widget must still work.

function key(widgetId) {
  return `helpinator:${widgetId}`
}

export function loadState(widgetId) {
  try {
    const raw = localStorage.getItem(key(widgetId))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveState(widgetId, state) {
  try {
    localStorage.setItem(key(widgetId), JSON.stringify(state))
  } catch { /* storage unavailable — the chat still works for this page view */ }
}

export function clearState(widgetId) {
  try {
    localStorage.removeItem(key(widgetId))
  } catch { /* ignore */ }
}
