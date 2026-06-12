## About this Project

A Claude Code plugin that captures plans, tools and execution summaries to an Obsidian vault using hooks:

- PostToolUse, ExitPlanMode → `capture-plan.ts`: Captures plan content, summarizes with Claude Haiku, writes an Obsidian note, appends to daily journal
- Stop → `capture-done.ts`: Parses the session transcript, extracts execution results

## Commands

- bun test
- bun test capture-done.test.ts # Run a single test file
- bun test --grep "pattern" # Run tests matching a pattern
- bun test --watch # Watch mode
- bun check # Biome lint + format check
- bun check:fix # Auto-fix biome issues

No build step — Bun runs TypeScript natively.

## Code Standards

- No `any` types — use proper interfaces, `unknown`, or type-safe helpers. `noExplicitAny` is an error
- No non-null assertions (`!`) — use optional chaining (`?.`), guards, or local const extraction instead
- JSDoc on all exports — every exported function, type, and interface must have a `/** ... */` comment
- For Bun process mocks in tests, use the `spawnSyncResult()` helper in `shared.external.test.ts` instead of `as any` casts
- Run `bun check` before committing

## Architecture

### Vault Mutation Rule

All vault mutations (create, delete, move, append, property changes) MUST go through the Obsidian CLI (`runObsidian`). Never use `node:fs` write operations (`writeFileSync`, `Bun.write`, `appendFileSync`, `rmSync`, `unlinkSync`, `renameSync`) on vault paths. Direct reads (`readFileSync`, `existsSync`, `readdirSync`, `statSync`, `Bun.file().text()`) are safe — they don't affect the vault index.

To replace an existing vault file, use `create` with the `overwrite` flag (see `createVaultNote` in `obsidian.ts`). Do not use move+create+delete — the `move` command triggers Obsidian's auto-link-update, corrupting wikilinks across the vault.

### Obsidian CLI Reference

See `docs/obsidian-cli.md` for the full Obsidian CLI command reference, including documented mismatches between the official docs and actual behavior, and workarounds learned from this project. Consult this document when you need to understand a specific command and its usage. This document should be maintained — any time we encounter a new CLI quirk, workaround, or undocumented behavior, annotate it into the "Learned Behaviors & Workarounds" section.

### Hook Data Flow

1. `capture-plan.ts` receives the ExitPlanMode payload via stdin JSON, extracts plan content, creates an Obsidian note at `<vault>/<plan.path>/<date_scheme_path>/<counter>-<slug>/plan.md`
2. `capture-done.ts` receives the Stop payload via stdin JSON, reads saved session state, finds and parses the transcript, and writes `summary.md` in the same directory

### Date Directory Schemes

The `date_scheme` setting controls how date segments are formatted in vault paths. Four named schemes are available: `calendar` (default), `compact`, `monthly`, `flat`. Each path (`[plan]`, `[journal]`, `[skills]`) can be configured independently via TOML grouped tables. Exception: `[skills]` inherits its `date_scheme` from `[plan]` when not explicitly set, rather than falling back to the hardcoded default.

### Config Cascade (highest priority wins)

1. Project local: `$PROJECT/.claude/capture-plan.toml`
2. User global: `~/.config/capture-plan/config.toml`
3. Plugin default: `capture-plan.toml` (repo root)

Old flat keys (`plan_path`, `journal_path`, `skills_path`) are still accepted for backward compatibility; new `[plan]`/`[journal]`/`[skills]` tables take precedence.

The `[skills]` table controls where skill-only session notes (`activity.md`) are written:
- Default path: `Claude/Skills`
- `date_scheme`: inherits from `[plan]` when omitted — this is the only table with cross-table inheritance; `[plan]` and `[journal]` each fall back to the hardcoded default independently.
- Flat fallback key: `skills_path`

### Session State

`<vault>/<plan.path>/<date_scheme_path>/<counter>-<slug>/state.md` bridges the two hooks — written by capture-plan, read by capture-done.

`SessionState.plan_dir` keeps its legacy name but the root it is relative to depends on `source`: `source: "skill"` → relative to `config.skills.path`; any other source → relative to `config.plan.path`.

### Troubleshooting

If the LSP tool reports diagnostics about missing exports or types that clearly exist in the code (and tests pass), the TypeScript language server has stale state. Restart it:

    ./scripts/kill-tsserver.sh

This targets only tsserver processes belonging to the current Claude Code process. The LSP respawns on the next request

Debug Logs are written to `<os.tmpdir()>/capture-[plan|done]-debug.log` (typically `/tmp/...` on macOS/Linux, `%TEMP%\...` on Windows).

### Plugin Layout

- skills/ — Plugin-distributed skills (discovered globally when plugin is installed). Must be top-level, not inside .claude/
- .claude/commands/ — Project-local dev commands (start-dev, end-dev, release). Only visible when working in this repo
- .claude-plugin/ — Plugin metadata: plugin.json, marketplace.json, hooks/hooks.json
