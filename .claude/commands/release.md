---
description: "Use when the user wants to release a new version of the capture-plan plugin. Bumps version numbers, commits, tags, pushes, and creates a GitHub release. Also supports `rewrite` to regenerate the body of an existing release."
argument-hint: "[major|minor|patch|rewrite]"
---

# Release

Automate version bumping and GitHub release creation for the capture-plan plugin.

This command always operates on `main` for new releases. If invoked from another branch, it will stash local changes and switch to main before releasing. Rewrite mode (see below) does not touch git state.

The repo slug is hardcoded as `kriswill/capture-plan` throughout this command — this plugin is not intended to be forked-and-reused.

## Arguments

The user provides one argument:

- `major`, `minor`, `patch` — bump type for a new release. Default to `patch` if not specified.
- `rewrite` — regenerate the title + body of an **existing** GitHub release using the same formatting this command now produces for new releases. No commits, tags, pushes, or version-file edits occur.

When the argument is `rewrite`, follow the **Rewrite mode** section below **instead of** steps 0–8.

## Rewrite mode

Use this mode to back-port the release-notes format to historical releases. It runs `gh release edit` on an existing tag — nothing else.

> **Warning.** This overwrites the existing release body. If the current body has manually-edited content worth preserving, capture it first with `gh release view <tag> --json body -q .body` before confirming.

### R1. Pick a release

List recent releases:

```bash
gh release list --limit 50 --json tagName,name,publishedAt,isLatest
```

Present the results to the user via `AskUserQuestion`. Question: *"Which release do you want to rewrite?"*, header: `Release`. Each option label: `<tagName> — <name or tagName> (<YYYY-MM-DD>)`. Mark the most recent option `(Recommended)` only when it's the obvious target. `AskUserQuestion` caps at 4 options, so show the 4 most recent and rely on "Other" free-text for older tags.

Record the selected tag as `TARGET_TAG` (e.g. `v0.6.1`) and `DISPLAY_VERSION` as `TARGET_TAG` without the leading `v` (e.g. `0.6.1`).

### R2. Compute the previous tag

```bash
PREV_TAG=$(git describe --tags --abbrev=0 "${TARGET_TAG}^" 2>/dev/null || true)
```

If `PREV_TAG` is empty, this is the first release — pass `PREV=""` to `GEN_CHANGELOG` so 3a reads the full history and 3e skips the compare footer.

### R3. Generate the body

Call **GEN_CHANGELOG** (see section below) with `PREV=$PREV_TAG`, `TARGET=$TARGET_TAG`, `DISPLAY_VERSION=$DISPLAY_VERSION`. The result lands in `/tmp/capture-plan-release-notes.md`. Doc cross-ref links pin to `blob/v$DISPLAY_VERSION/...` — the doc as it existed at that release.

### R4. Replace the release body on GitHub

```bash
gh release edit "$TARGET_TAG" \
  --title "$TARGET_TAG" \
  --notes-file /tmp/capture-plan-release-notes.md
rm -f /tmp/capture-plan-release-notes.md
gh release view "$TARGET_TAG" --json url -q .url
```

`gh release edit` overwrites the body in place; it does not create a new tag or touch git history. Print the URL so the user can inspect the result.

### R5. What rewrite mode must NOT do

- No `git switch`, `git stash`, `git commit`, `git tag`, `git push`.
- No edits to `package.json`, `.claude-plugin/plugin.json`, or `.claude-plugin/marketplace.json`.
- No marketplace cache pull (step 7). Rewriting release notes has no effect on plugin version resolution.
- No `bun test` gate — rewriting prose can't break the build.

## Procedure (new release)

### 0. Ensure on up-to-date main

Releases MUST originate from main. Before anything else:

1. Run `git status --porcelain`. If there are uncommitted or untracked changes, run `git stash push -u -m "pre-release auto-stash"` and REPORT to the user which files were stashed plus the stash ref. Tell them to `git stash pop` after the release if they want those changes back.
2. Capture the starting branch name (`git branch --show-current`).
3. If the current branch is not `main`, run `git switch main`.
4. `git fetch origin main`.
5. If local `main` is behind `origin/main`, run `git pull --ff-only origin main`. If a fast-forward is not possible (diverged main), STOP and report to the user — do not attempt to merge or rebase.
6. Proceed with the rest of the release procedure from main.

### 1. Determine new version

Read `package.json` to get the current version. Parse it as `major.minor.patch` and increment the appropriate segment:

- `patch`: `1.3.0` → `1.3.1`
- `minor`: `1.3.0` → `1.4.0`
- `major`: `1.3.0` → `2.0.0`

### 2. Update all version files

Update the version string in ALL of these files — missing any one will cause the plugin system to not detect the update:

| File | Fields to update |
|------|-----------------|
| `package.json` | `"version"` |
| `.claude-plugin/plugin.json` | `"version"` |
| `.claude-plugin/marketplace.json` | `"metadata"."version"` AND `"plugins"[0]."version"` (two occurrences) |

Use the Edit tool with `replace_all: true` for marketplace.json since both version fields should have the same value.

### 3. Generate changelog (before committing)

Call **GEN_CHANGELOG** with:

- `PREV=$(git describe --tags --abbrev=0)` — if this fails (no prior tag), pass `PREV=""`.
- `TARGET=HEAD`
- `DISPLAY_VERSION={NEW_VERSION}` (the version computed in step 1, without a leading `v`).

The sub-procedure writes the final body to `/tmp/capture-plan-release-notes.md`. Steps 5 and 6 pick it up from there.

### 4. Run tests

Run `bun test` and confirm all tests pass. If tests fail, stop and fix before continuing.

### 5. Commit and tag

GPG signing is enabled — tags require the `-m` flag or they fail with "no tag message?".

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "release: v{VERSION}"
git tag -m "v{VERSION}" v{VERSION}
```

### 6. Push and create GitHub release

```bash
git push && git push --tags
gh release create v{VERSION} --title "v{VERSION}" --notes-file /tmp/capture-plan-release-notes.md
rm -f /tmp/capture-plan-release-notes.md
```

Using `--notes-file` avoids multi-line shell-escaping headaches with the generated markdown.

### 7. Update local marketplace cache

> **Workaround for CLI bug** ([anthropics/claude-code#37252](https://github.com/anthropics/claude-code/issues/37252)):
> `claude plugin update` reads versions from a local git clone without fetching from the remote first.

Pull the latest into the marketplace cache so `claude plugin update` detects the new version immediately:

```bash
if [ -d ~/.claude/plugins/marketplaces/kriswill ]; then
  cd ~/.claude/plugins/marketplaces/kriswill && git pull origin main
fi
```

Skip silently if the directory doesn't exist (e.g., plugin not installed locally).

### 8. Confirm

Print the release URL returned by `gh release create`.

Verify the marketplace cache is current:

```bash
cd ~/.claude/plugins/marketplaces/kriswill && git log --oneline -1
```

Confirm the latest commit message matches `release: v{VERSION}`.

## Sub-procedure: GEN_CHANGELOG(PREV, TARGET, DISPLAY_VERSION)

Assembles a categorized, linked release body and writes it to `/tmp/capture-plan-release-notes.md`. Called from step 3 (new release) and R3 (rewrite mode).

Inputs:

- `PREV` — git ref marking the previous release boundary (a tag, or empty for first release).
- `TARGET` — git ref being released (`HEAD` for a new release, `vX.Y.Z` for a rewrite).
- `DISPLAY_VERSION` — version string used in doc-blob URLs and the compare footer (e.g. `0.6.1`, no leading `v`).

### 3a. Collect raw data

If `PREV` is non-empty, use `"$PREV".."$TARGET"` as the range. If `PREV` is empty (first release), use just `"$TARGET"`.

```bash
git log <RANGE> --no-merges --pretty=format:'%H%x09%s'
git log <RANGE> --merges   --pretty=format:'%H%x09%P%x09%s'
git log <RANGE> --name-only --pretty=format:'---%n%H%n%s'
```

The merge line's `%P` gives parent SHAs (space-separated); the second parent is the PR branch tip. The name-only log lets you see which files each commit touched, for the docs cross-ref heuristic in 3d.

### 3b. Categorize non-merge commits

Group by conventional-commit prefix. **Skip** any commit whose subject starts with `release:` (these are prior version bumps). Omit empty sections in the final output.

| Prefix | Section heading |
|---|---|
| `feat:` | `### Features` |
| `fix:` | `### Bug fixes` |
| `perf:` | `### Performance` |
| `refactor:` | `### Refactors` |
| `test:` | `### Tests` |
| `docs:` | `### Documentation` |
| `chore:`, `ci:`, `build:` | `### Chore` |
| anything else | `### Other` |

**PR mapping.** For each merge commit, extract `#N` from its subject (typical form: `Merge pull request #N from <branch>`). Take the merge's two parents `P1 P2` from `%P` and run:

```bash
git log "$P1".."$P2" --pretty=format:%H
```

Every SHA printed is a commit that came in via PR `N`. Build a lookup `sha → PR#`. Merge commits themselves are **not** rendered as bullets; their PR number is attached to the underlying commits instead.

**Short-circuit.** If no commits remain after filtering (e.g. the range contains only prior `release:` bumps), write exactly this to the output file and stop:

```
Patch release — version bump only.
```

### 3c. Prose summary

Above the section headings, write a 2–4 sentence paragraph describing the *themes* of the release, grounded in the categorized commits and the files they touched. Do not invent claims unsupported by the commits. Do not enumerate commits — the bullets do that.

### 3d. Bullet format

Each bullet:

```
- <subject with prefix stripped> ([`<sha7>`](https://github.com/kriswill/capture-plan/commit/<FULL_SHA>))[ · [(#<N>)](https://github.com/kriswill/capture-plan/pull/<N>)][ · see [docs/<file>.md](https://github.com/kriswill/capture-plan/blob/v<DISPLAY_VERSION>/docs/<file>.md)]
```

- `sha7` = first 7 characters of the full SHA.
- PR suffix: include only if the commit appears in the `sha → PR#` map.
- Doc suffix: include only when the commit's changed-files include a `docs/*.md` file **or** the commit clearly relates to a documented subsystem (judgement call — do not spam doc links on every bullet). Always pin doc links to `blob/v<DISPLAY_VERSION>/...` so they are stable for that specific release (for rewrites, this is the historical tag, not `main`).

### 3e. Footer

If `PREV` is non-empty, append this line as the last line of the body:

```
**Full changelog:** https://github.com/kriswill/capture-plan/compare/<PREV>...v<DISPLAY_VERSION>
```

If `PREV` is empty (first release), omit the footer.

### 3f. Example rendered shape (illustrative, for v0.6.1)

```
This release hardens the Stop-hook fast path and enforces that releases always originate from `main`. Test coverage was added to lock the new gating behavior.

### Features
- enforce main-branch check in /release command ([`03a0bfc`](https://github.com/kriswill/capture-plan/commit/03a0bfc...) · [(#11)](https://github.com/kriswill/capture-plan/pull/11))

### Performance
- use hint-based fast path to locate plan state on stop ([`64d3930`](https://github.com/kriswill/capture-plan/commit/64d3930...) · [(#10)](https://github.com/kriswill/capture-plan/pull/10))

### Tests
- lock resolveVaultState fast-path and fallback behavior ([`a431b79`](https://github.com/kriswill/capture-plan/commit/a431b79...) · [(#10)](https://github.com/kriswill/capture-plan/pull/10))

**Full changelog:** https://github.com/kriswill/capture-plan/compare/v0.6.0...v0.6.1
```

### 3g. Write the file

Write the assembled body to `/tmp/capture-plan-release-notes.md` using the Write tool. Callers (step 6, R4) pick it up from there and remove it when done.
