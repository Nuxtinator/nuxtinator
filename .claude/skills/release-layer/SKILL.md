---
name: release-layer
description: Cut a release for one nuxtinator layer — bump its version, commit, create the @nuxtinator/<id>@x.y.z git tag, and push it (publishing the layer for consumers). Use when asked to release, tag, publish, or cut a version of a layer, e.g. "release the feedback layer", "tag messages 1.2.0", "cut a minor release of core", "publish a patch for videos". Run from inside the nuxtinator monorepo. Argument: <layer-id> [<version | patch | minor | major>].
---

# release-layer

Cut a version release for a single nuxtinator layer. A "release" = bump the layer's `version` field, commit it, create the matching git tag, and push. Publishing the tag is what makes the version available: consumers' `latest` / `^range` policies resolve against tags, so until a tag is pushed nothing reaches them.

## When to use

- "release / tag / publish the `<layer>` layer", "cut a patch/minor/major of `<layer>`", "tag `<layer>` `<version>`".
- Only inside the **nuxtinator monorepo** — the repo that has `scripts/release.ts` and `layers/*` workspaces (remote `corsacca/nuxtinator`). If the current repo doesn't have `scripts/release.ts`, stop and say this skill must be run from the nuxtinator repo.
- One layer per invocation. To release several, run it once per layer (versions are independent).

## Conventions

- **Tag format:** `@nuxtinator/<id>@<x.y.z>` (the layer's package `name` + `@` + version). One repo, one shared tag namespace, per-layer prefix.
- **Source of truth:** the `version` field in `layers/<path>/package.json` owns the number; the tag is derived from it in the same step so the two can't drift.
- **Honest semver (this is the one judgment call):** a breaking change to a host-facing contract (an alias, a composable, a registry signature) = **major**; a new capability = **minor**; a fix = **patch**. Consumers pinning `^x` trust this label — mislabeling a breaking change as minor will break them silently.
- `master` can run ahead of the last tag; releasing is a deliberate act, not something that happens on every commit.

## Steps

1. **Resolve the layer.** Map the requested layer to a workspace under `layers/` by reading the root `package.json` `workspaces` (the id is the last path segment, e.g. `feedback` → `layers/apps/feedback`). If it's ambiguous or not found, list the known layer ids and ask.

2. **Decide the version.**
   - If given an explicit version, confirm it's valid semver and **greater** than the layer's current `version` (the script enforces this — `next > current`).
   - If given `patch` / `minor` / `major`, that's the bump.
   - If nothing was given, look at what changed for that layer since its last tag — `git log <last-tag>..HEAD -- <layer-path>` (last tag: `git tag -l '@nuxtinator/<id>@*' | sort -V | tail -1`) — propose patch/minor/major from the nature of the changes, and confirm with the user before proceeding.

3. **Pre-flight (a tag must point at pushed code containing this version).**
   - Confirm the repo root has `scripts/release.ts`.
   - `git fetch` and check the branch isn't behind/ahead of origin in a way that matters — the tag will point at `HEAD`, and `HEAD` must be pushed for the tag to be useful to consumers.
   - **Requirements.** If the layer now uses something new from another layer (a core util, a composable), its `package.json` `nuxtinator.requires` entry for that layer must name the minimum version that has it — raise it before releasing. Every monorepo layer named there needs a pushed tag in range; the script refuses otherwise ("release them first"), so release those layers first, then this one.
   - If the layer has **uncommitted changes**, surface them and confirm intent before tagging — you don't want to tag a version whose code isn't in the commit the tag points at. Offer to let the user commit first (don't commit on their behalf unless they say so).

4. **Cut it.** From the repo root:
   ```
   bun run release <layer> <version> --push
   ```
   This bumps the `version` field, makes a path-scoped commit of just that change, tags `@nuxtinator/<id>@<version>`, and pushes the commit + tag. Drop `--push` only if the user asked to keep it local — then tell them the `git push --follow-tags` command to publish later.

5. **Verify and report.**
   - `git ls-remote --tags origin '@nuxtinator/<id>@<version>'` confirms it's on the remote.
   - Report: the tag created, the commit it points at, and that it's pushed. Note that consumers on `latest` will pick it up on their next `layers:update`, and consumers on `^<major>` get it if it's in range (a new **major** is held for them, not auto-taken).

## Notes and edge cases

- **`next <= current` is refused** by the release script — you can't re-tag an existing version; bump higher.
- **Baseline tag of a layer that already sits at its version with no tag yet** (e.g. a fresh layer seeded at `1.0.0`): the script's bump can't produce a tag equal to the current version. Create it directly instead — `git tag '@nuxtinator/<id>@<version>'` on the pushed `HEAD`, then `git push origin 'refs/tags/@nuxtinator/<id>@<version>'`.
- **Pushing is outward** (public repo, hard to reverse). Invoking this skill with a version is the go-ahead to push; if the user said "local only" / "don't push", omit `--push` and hand them the push command.
- This skill releases; it does not migrate consumers or open update PRs — those happen on the consumer side (their `layers:update` / the layer-updates GitHub Action).
