# capture-plan

> **Warning:** This project is under heavy development churn. Interfaces and features are evolving rapidly and may be unstable from version to version.

A Claude Code plugin that captures plans and execution summaries to an Obsidian vault.

## What it does

The plugin captures three types of Claude Code sessions:

- **Plan mode**: On ExitPlanMode, captures the plan content, summarizes it with Claude Haiku, creates an Obsidian note with YAML frontmatter, and appends an entry to your daily journal. On Stop, creates a summary note with execution results, plus tools-stats, tools-log, and (if subagents were used) agent prompt notes.
- **Superpowers**: Auto-detects [superpowers](https://github.com/obra/superpowers/tree/main?tab=readme-ov-file#superpowers) sessions by scanning the transcript for Write operations to spec/plan directories. Creates vault notes with `source: superpowers` metadata. Specs and plans get separate sibling notes.
- **Skill capture**: Detects skill-only sessions and creates activity notes with a skill invocation table. Only skills listed in `capture_skills` are captured as standalone sessions; skills used during plan-mode or superpowers sessions are always captured as sibling notes.

Notes are organized as (default `calendar` scheme):
```
Claude/Plans/
  └── <yyyy>/
      └── <mm-Month>/
          └── <dd-Day>/
              └── <counter>-<slug>/
                  ├── plan.md
                  ├── summary.md
                  ├── tools-stats.md
                  ├── tools-log.md
                  └── agents/          (if subagents used)
```

Session documents (when `session.enabled = true`):
```
Claude/Sessions/
  └── <project>/
      ├── 001-<id-prefix>.md
      ├── 002-<id-prefix>.md
      └── …
```

## Prerequisites

1. **[Bun](https://bun.sh)** runtime (v1.0+)

   ```sh
   bun --version
   ```

2. **[Obsidian CLI](https://obsidian.md)** — the `obsidian` command must be available on PATH

   ```sh
   obsidian --help    # should print "Obsidian CLI" and a list of commands
   ```

3. **An Obsidian vault** — verify yours is visible to the CLI:

   ```sh
   obsidian vaults    # should list your vault names
   ```

## Installation

### Option A: CLI (recommended)

1. Add the marketplace:

   ```sh
   claude plugin marketplace add kriswill/capture-plan
   ```

2. Install the plugin:

   ```sh
   claude plugin install capture-plan@kriswill
   ```

### Option B: Manual settings.json

1. Add both the marketplace and the enabled flag to `~/.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "kriswill": {
         "source": {
           "source": "github",
           "repo": "kriswill/capture-plan"
         }
       }
     },
     "enabledPlugins": {
       "capture-plan@kriswill": true
     }
   }
   ```

2. Restart Claude Code, or run `/reload-plugins` inside an active session.

### Verify

After installation, confirm the hooks are active:

- `/reload-plugins` output should include the capture-plan hooks in its count.
- Enter plan mode, write a plan, and exit. Check that a note appears under `Claude/Plans/` in your vault.

### Troubleshooting

Debug logs with ISO timestamps are written to two files:

- `/tmp/capture-plan-debug.log` — ExitPlanMode hook: plan extraction, Haiku summarization, vault note creation, journal appends
- `/tmp/capture-done-debug.log` — Stop hook: transcript parsing, session type detection, summary/tools-stats/tools-log generation

Logs accumulate across sessions. To start fresh:

```sh
rm /tmp/capture-plan-debug.log /tmp/capture-done-debug.log
```

## Configuration

The plugin ships with a default config. Override settings at any of these locations (highest priority wins):

1. **Project local**: `$PROJECT/.claude/capture-plan.toml`
2. **User global**: `~/.config/capture-plan/config.toml`
3. **Plugin default**: `capture-plan.toml` (shipped with plugin)

### Config options

```toml
# Obsidian vault name (run `obsidian vaults` to list available vaults)
vault = "Personal"

# Override the project name (default: directory name)
# project_name = "my-project"

# Plan notes configuration
[plan]
path = "Claude/Plans"
date_scheme = "calendar"   # calendar | compact | monthly | flat

# Journal entries configuration
[journal]
path = "Journal"
date_scheme = "calendar"   # calendar | compact | monthly | flat

# Context window cap in tokens (auto-detected, override if needed)
# Standard: 200000, Max/Enterprise: 1000000
# context_cap = 1000000

# Superpowers integration — auto-detected from transcript at session end.
# Override patterns if superpowers writes to non-default directories.
# superpowers_spec_pattern = "/superpowers/specs/"
# superpowers_plan_pattern = "/superpowers/plans/"

# Skills to capture as standalone sessions (whitelist).
# Only skill-only sessions matching this list are captured.
# Skills during plan-mode/superpowers sessions are always captured.
# capture_skills = ["simplify"]

# Session document capture (toggle via /session skill)
# Creates session documents that cross-link to plans/summaries/tools.
# Path uses project-based grouping: <path>/<project>/<counter>-<id-prefix>.md
[session]
enabled = false
path = "Claude/Sessions"
prompt_max_chars = 1000

# Obsidian Bases (database views over captured notes) — managed by the plugin.
# The plugin keeps these .base files authoritative: manual edits are replaced
# on the next session start. Set enabled = false to stop managing them.
[bases]
enabled = true
path = "Claude/Bases"
```

The `date_scheme` setting controls how date segments are formatted in vault paths. Four schemes are available:

| Scheme | Plan path example | Journal path example |
|---|---|---|
| `calendar` (default) | `Claude/Plans/2026/04-April/04-Saturday/…` | `Journal/2026/04-April/04-Saturday.md` |
| `compact` | `Claude/Plans/2026/04-04/…` | `Journal/2026/04-04.md` |
| `monthly` | `Claude/Plans/2026/04-April/04/…` | `Journal/2026/04-April/04.md` |
| `flat` | `Claude/Plans/2026-04-04/…` | `Journal/2026-04-04.md` |

Old flat keys (`plan_path`, `journal_path`) are still accepted for backward compatibility; the `[plan]`/`[journal]` tables take precedence.

The `context_cap` setting controls the context window size recorded in note frontmatter (`context_window`). By default, the plugin assumes 200K and auto-detects 1M when a single turn exceeds 200K tokens. Set this explicitly if you're on Claude Max or Enterprise and want it to always show 1M. Token usage (input, output, cache), peak context %, duration, model, and subagent count are all computed from the transcript and recorded in both the note frontmatter and the `tools-stats.md` companion note.

## How it works

### Session types

The plugin uses two hooks that run at different points in a Claude Code session:

1. **ExitPlanMode** (`capture-plan.ts`): Fires when you exit plan mode. Extracts the plan content, summarizes it with Claude Haiku, creates the vault note, and appends a journal entry. Writes a session state file that the Stop hook picks up later.
2. **Stop** (`capture-done.ts`): Fires when the session ends. Detects the session type and creates companion notes:
   - **Plan mode** — Reads the state file written by ExitPlanMode, parses the transcript for execution activity after the plan boundary, and creates the summary, tools-stats, and tools-log notes.
   - **Superpowers** — No ExitPlanMode needed. Scans the transcript for Write tool calls whose `file_path` matches `superpowers_spec_pattern` or `superpowers_plan_pattern`. Creates the plan note on the fly, then captures execution results the same way as plan mode.
   - **Skill-only** — Detected when the transcript contains Skill tool invocations but no plan-mode or superpowers activity. Filtered by the `capture_skills` whitelist. Creates an activity note with a skill invocation table, then captures execution results.

A **SessionStart** hook (`capture-session-start.ts`) runs at the beginning of each session to detect the context window size and Claude Code version, writing a hint file that downstream hooks use for metadata. When `session.enabled` is `true`, it also creates the initial session document in the vault.

A **session event** hook (`capture-session-event.ts`) handles mid-session lifecycle events when session capture is enabled. It records user prompts (code-fenced, truncated to `prompt_max_chars`), plan mode transitions, subagent start/stop, and context compaction events. Each event is appended as a timestamped heading under the session document's Events section.

### Companion notes

Each captured session produces a directory of related notes:

| Note | Description |
|---|---|
| `plan.md` | The captured plan content with AI-generated title, summary, and tags |
| `activity.md` | Skill-only sessions: a table of skill invocations (time, name, args) with surrounding context |
| `summary.md` | Execution results: AI-generated summary, list of files changed, session duration |
| `tools-stats.md` | Session metrics: model, duration, token counts (in/out/cache), context %, subagent count, tool call/error totals, MCP servers. Planning and execution phases shown separately plus combined totals |
| `tools-log.md` | Chronological tool call log: each turn shows timestamp, duration, token usage, justification text, and tool arguments as markdown tables. Bash commands appear as shell code fences |
| `agents/` | Subagent prompts extracted into separate notes with their own frontmatter (subagent type, model, token/duration stats, backlink to the dispatching turn in tools-log) |
| `<session>.md` | Session log: timestamped lifecycle events (prompts, plan mode, subagents, compaction, stop). Lives under `Claude/Sessions/<project>/` |
| `spec.md` | Superpowers only: the spec file content, linked to the plan note |

### Note frontmatter

All notes include YAML frontmatter with Obsidian-compatible wikilinks, designed to be queryable from Obsidian Bases. Key fields:

| Field | Example | Notes |
|---|---|---|
| `type` | `plan`, `summary`, `tools-stats`, `tools-log`, `agent`, `activity`, `spec`, `skill`, `session`, `journal` | Doc-type discriminator |
| `date` | `2026-04-04` | Scalar date for sorting/filtering in Bases |
| `created` | `"[[Journal/2026/04-April/04-Saturday\|2026-04-04 2:30 PM]]"` | Wikilink to daily journal |
| `project` | `capture-plan` | Git repo name (auto-detected from cwd) |
| `tags` | `- refactor` | AI-generated from plan/summary content |
| `session` | `"[[Sessions/abc123]]"` | Session ID link |
| `model` | `claude-opus-4-6` | Bare model id (context window split out) |
| `context_window` | `1000000` | Context window size in tokens |
| `context_pct` | `42` | Peak context window usage % |
| `duration` | `"12m 34s"` | Human-readable session duration |
| `duration_s` | `754` | Numeric duration in seconds (sortable) |
| `cc_version` | `"1.0.28"` | Claude Code version |
| `source` | `superpowers` or `skill` | Session type (absent for plan-mode) |
| `spec_file` | `"/path/to/spec.md"` | Source spec path (superpowers only) |
| `skills` | `- simplify` | Skill names (skill-only sessions) |
| `tokens_in` | `45200` | Input tokens consumed |
| `tokens_out` | `12800` | Output tokens generated |
| `subagents` | `3` | Number of subagents dispatched |
| `tools_used` | `87` | Total tool calls |
| `total_errors` | `2` | Total tool errors |

### Obsidian Bases

The plugin maintains a set of [Obsidian Bases](https://help.obsidian.md/bases) — database-style table views over the captured notes — under `Claude/Bases/` (configurable via `[bases] path`):

| Base | Rows | Views |
|---|---|---|
| `claude-runs.base` | One per executed plan (`tools-stats.md`) | Recent runs, By project, Heaviest runs (by total tokens), High context pressure (≥20%), Runs with errors |
| `claude-plans.base` | One per captured plan | All plans, By project, Superpowers |
| `claude-agents.base` | One per subagent dispatch | Recent dispatches, By agent type, By model |
| `claude-sessions.base` | One per session document | Recent sessions, By project |
| `claude-journal.base` | One per daily journal note | Daily journal |

Management is **authoritative**: at session start the plugin compares each `.base` file against its canonical definition and replaces it if it differs, so manual edits don't survive. To keep a customized view, copy the base under a different name (anything not prefixed with `claude-` in the bases folder is left alone), or set `[bases] enabled = false` to stop management entirely. e2e-test artifacts are filtered out of all plan-tree views.

### Daily journal

Journal entries are grouped by plan title as Obsidian callouts. Each callout contains timestamped revisions with the note type (plan, done, activity), model label, and AI summary:

```markdown
> [!note]+ Refactor auth middleware — *capture-plan*
> **2:30 PM** [[plan|plan]] `opus-4-6 (1M)` Extract auth middleware into shared module #refactor
> **2:45 PM** [[summary|done]] `opus-4-6 (1M)` Completed refactor, 4 files changed #refactor
```

Journal frontmatter tracks the date, day name, projects active that day, and aggregated tags from all sessions.

## Skills

These slash commands are available to all users when the plugin is installed.

### `/backport-journal`

Imports plans from `~/.claude/plans/` into the Obsidian vault, creating both plan notes and daily journal entries. Walks you through filtering (by date range, project, or specific plans), choosing between AI-generated or fast text summaries, previewing with a dry run, and confirming before import. Already-imported plans are skipped automatically.

### `/migrate-layout`

Migrates existing vault plan directories and journal files from one date directory scheme to another. Use after changing `date_scheme` in `capture-plan.toml`. Previews all moves in a dry run, confirms with the user, then executes. Supports `--plan-only` and `--journal-only` flags to migrate a single path.

### `/rewrite-journal`

Reconstructs the daily journal for a selected day by reading all plan and summary notes for that date. Backs up the existing journal file before rewriting. Offers AI summaries (Claude Haiku) or fast text extraction. Walks through day selection, dry run preview, execution, and optional backup cleanup.

### `/config-print`

Displays all config options in a table showing the effective value and which config layer (default, plugin, user, or project) set each one. Also lists config file paths and whether each exists.

### `/session`

Toggles session document capture on or off. Pass `on`, `off`, or no argument to toggle the current state. Asks where to save the setting (project-local `.claude/capture-plan.toml` or user-global `~/.config/capture-plan/config.toml`). The change takes effect on the next session start.

### `/session-print`

Shows current session statistics: session ID, project, model, Claude Code version, duration, and whether session capture is enabled. Also displays activity counts (prompts, plan mode entries, compactions, subagent launches), token usage breakdown (input, output, cache read/create, peak context), top tools by call count, and connected MCP servers.

## Developer Commands

These commands are only available when working inside the capture-plan repository. They are not distributed to end users.

### `/release [major|minor|patch]`

Bumps the version across all plugin files (`package.json`, `plugin.json`, `marketplace.json`), runs tests, commits, tags, pushes, and creates a GitHub release. Defaults to `patch` if no bump type is specified.

### `/start-dev`

Enables dev mode by symlinking the plugin cache to the local repo checkout. Hook changes take effect immediately without releasing a new version.

### `/end-dev`

Disables dev mode by removing the symlink and restoring the cached release copy.

### `/test-e2e`

Runs the full hook lifecycle end-to-end against the real Obsidian vault: SessionStart → capture-plan (ExitPlanMode) → capture-done (Stop) → journal. Uses synthetic payloads and transcript data. Validates 33 checks across all output files (plan, summary, tools-stats, tools-log, journal entries), writes a `test-log.md` results table to the vault, then cleans up all test artifacts.

### `/test-e2e-skip-clean`

Same as `/test-e2e` but preserves all generated vault artifacts for manual inspection in Obsidian. Useful for debugging or verifying note formatting.

### `/test-e2e-migration`

Interactive roundtrip migration test with content integrity verification. Asks which path (plan/journal), detects the current date scheme on disk, lets you pick a target scheme, then runs a full roundtrip migration and back. Verifies MD5 hashes, file counts, directory counts, and stationary file integrity.

## License

MIT
