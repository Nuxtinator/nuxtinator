import semver from 'semver'
import { getRegisteredApp } from './app-registry'

// "Updates available" for the layers this build was assembled from. Reads the
// build-injected lock (modules/layer-versions.ts) for what's installed and where
// each layer comes from, then lists each source repo's tags to see what's newer.
//
// current        — the version this build is running (parsed from the locked ref)
// latestInRange  — the newest version the layer's declared policy would take now
// latest         — the newest version that exists at all (for the held-major signal)
//
// Read-only: this never writes anything or touches GitHub auth beyond an optional
// read token. Results are cached so opening the admin page doesn't hammer the API.

export interface LayerUpdate {
  id: string
  name: string // the layer's display name — its registered launcher title, else the id
  pkg: string
  policy: string
  current: string | null // null when tracking a raw ref (e.g. 'master')
  latestInRange: string | null
  latest: string | null
  updateAvailable: boolean // a newer in-range version exists
  majorHeld: boolean // a newer version exists outside the range (needs a manual bump)
  compatible: boolean // every layer this one declares in `nuxtinator.requires` is loaded at a satisfying version
  unmet: UnmetRequirement[]
}

export interface UnmetRequirement {
  pkg: string
  range: string
  loaded: string | null // null when the required layer isn't loaded at all
}

interface LockEntry {
  pkg: string
  version: string // the declared policy
  ref: string // the resolved git ref
  source: string // github:<owner>/<repo>/<subdir>
  tagPrefix: string
}

const CACHE_TTL = 6 * 60 * 60 * 1000
let cache: { at: number, data: LayerUpdate[] } | null = null

// 'github:owner/repo/sub/dir' -> 'owner/repo'
function repoFromSource(source: string): string | null {
  const m = source.replace(/^github:/, '').split('/')
  return m.length >= 2 ? `${m[0]}/${m[1]}` : null
}

// The version a locked ref represents, or null for a raw branch/SHA.
function currentVersion(ref: string, tagPrefix: string): string | null {
  if (ref.startsWith(tagPrefix)) return semver.valid(ref.slice(tagPrefix.length))
  return null
}

async function listTags(repo: string, token: string): Promise<string[]> {
  const tags: string[] = []
  for (let page = 1; page <= 3; page++) {
    // Pin the request type to `string` (second generic) so $fetch skips deep
    // typed-route instantiation over the full route union — an external URL that
    // never matches a route, and the deep walk trips TS2589 as the app grows.
    const batch = await $fetch<{ name: string }[], string>(
      `https://api.github.com/repos/${repo}/tags`,
      {
        query: { per_page: 100, page },
        headers: {
          'User-Agent': 'nuxtinator-layer-updates',
          'Accept': 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }
    )
    tags.push(...batch.map(t => t.name))
    if (batch.length < 100) break
  }
  return tags
}

function inRangeVersion(policy: string, versions: string[]): string | null {
  const newest = () => semver.rsort([...versions])[0] ?? null
  if (policy === 'latest' || policy === '') return newest()
  if (semver.valid(policy)) return versions.includes(policy) ? policy : null // exact pin: no movement
  if (semver.validRange(policy)) return semver.maxSatisfying(versions, policy)
  return null // raw ref
}

export async function getAvailableLayerUpdates(opts?: { force?: boolean }): Promise<LayerUpdate[]> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL) return cache.data

  const config = useRuntimeConfig()
  const lock = (config.layerLock ?? {}) as Record<string, LockEntry>
  const token = (config.layerSourceToken ?? '') as string
  const unmetByPkg = (config.layerUnmet ?? {}) as Record<string, UnmetRequirement[]>

  // List each source repo's tags once, even when several layers share a repo.
  const tagsByRepo = new Map<string, string[]>()
  for (const entry of Object.values(lock)) {
    const repo = repoFromSource(entry.source)
    if (repo && !tagsByRepo.has(repo)) {
      try {
        tagsByRepo.set(repo, await listTags(repo, token))
      } catch {
        tagsByRepo.set(repo, []) // network/rate-limit failure -> degrade to unknown
      }
    }
  }

  const data: LayerUpdate[] = Object.entries(lock).map(([id, entry]) => {
    const repo = repoFromSource(entry.source)
    const allTags = repo ? (tagsByRepo.get(repo) ?? []) : []
    const versions = allTags
      .filter(t => t.startsWith(entry.tagPrefix))
      .map(t => semver.valid(t.slice(entry.tagPrefix.length)))
      .filter((v): v is string => Boolean(v))

    const current = currentVersion(entry.ref, entry.tagPrefix)
    const latest = semver.rsort([...versions])[0] ?? null
    const latestInRange = inRangeVersion(entry.version, versions)

    const updateAvailable = Boolean(current && latestInRange && semver.gt(latestInRange, current))
    const majorHeld = Boolean(current && latest && latestInRange && semver.gt(latest, latestInRange))

    const unmet = unmetByPkg[entry.pkg] ?? []
    const compatible = unmet.length === 0

    const name = getRegisteredApp(id)?.title ?? id
    return { id, name, pkg: entry.pkg, policy: entry.version, current, latestInRange, latest, updateAvailable, majorHeld, compatible, unmet }
  })

  cache = { at: Date.now(), data }
  return data
}
