import type { AiDbClient, AiUsageSubjectDef } from '#core/ai-fallback/types'

// Runtime registry of usage subjects: what, inside a feature, an AI call ran
// for (a bot, an inbox, a board). A call's `subject` is `<prefix>:<id>`; the
// layer that owns the prefix registers how to name its ids on the spend page.
// The log stores only the key, so a renamed or deleted subject reads as it is
// now.

const _subjects = new Map<string, AiUsageSubjectDef>()

export function registerAiUsageSubjects(def: AiUsageSubjectDef): void {
  if (!def || typeof def.prefix !== 'string' || !def.prefix || def.prefix.includes(':')) return
  if (_subjects.has(def.prefix)) return
  _subjects.set(def.prefix, def)
}

export function aiUsageSubject(prefix: string, id: string): string {
  return `${prefix}:${id}`
}

const NO_SUBJECT_LABEL = 'Not recorded'

// Labels for `subjects` ('' for calls with none), keyed by subject. A
// resolver that throws leaves its ids on the fallback label.
export async function usageSubjectLabels(tx: AiDbClient, subjects: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  const byPrefix = new Map<string, string[]>()
  for (const s of new Set(subjects)) {
    if (!s) {
      labels.set(s, NO_SUBJECT_LABEL)
      continue
    }
    const at = s.indexOf(':')
    const def = at > 0 ? _subjects.get(s.slice(0, at)) : undefined
    if (!def) {
      labels.set(s, s)
      continue
    }
    const id = s.slice(at + 1)
    labels.set(s, `${def.label} ${id.slice(0, 8)}`)
    byPrefix.set(def.prefix, [...byPrefix.get(def.prefix) ?? [], id])
  }
  await Promise.all([...byPrefix].map(async ([prefix, ids]) => {
    const def = _subjects.get(prefix)!
    const names = await def.resolve(tx, ids).catch((err) => {
      console.error(`[ai] usage subjects '${prefix}' not named: ${(err as Error)?.message ?? err}`)
      return new Map<string, string>()
    })
    for (const [id, name] of names) labels.set(aiUsageSubject(prefix, id), name)
  }))
  return labels
}

export function __resetAiUsageSubjectsForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('__resetAiUsageSubjectsForTests is not callable in production')
  }
  _subjects.clear()
}
