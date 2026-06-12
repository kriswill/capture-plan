---
name: backport-journal
description: Backport existing plans into the Obsidian daily journal. Use when plans exist in the vault but are missing journal entries.
---

# Backport Journal

Import plans from Claude Code's plans directory (`$CLAUDE_CONFIG_DIR/plans/`, defaulting to `~/.claude/plans/` when the env var is unset) into the Obsidian vault, creating both the vault plan note and a daily journal entry. Plans already imported (tracked via `source_slug` frontmatter) are skipped. The script resolves the directory itself — no path needs to be passed.

## Procedure

### 1. Discover plans

Run the discovery script from the plugin root directory to list all plans:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --list 2>/dev/null
```

Parse the JSON output. Each entry has: `sourceSlug`, `title`, `date`, `ampmTime`, `projectLabel`, `isImported`.

Count totals:
- Total plans found in the plans directory
- Already imported to vault
- New (not yet imported)

Tell the user: "Found N plans in the Claude Code plans directory, M already imported to vault, K are new."

If no new plans exist, inform the user and stop.

List the plans still missing, formatted as:

```
N. [YYYY-MM-DD HH:MM AM] [project/name] Title
```

### 2. Ask selection mode

Use `AskUserQuestion` with these options:

- **All new plans** — Import all plans not yet in the vault
- **Date range** — Specify start and end dates to filter
- **By project** — Filter by project name
- **Specific plans** — Pick individual plans from the list

### 3. Gather selection details

**If "Date range"**: Ask the user for start date and end date (YYYY-MM-DD format).

**If "By project"**: Display the unique project labels from the missing plans list. Ask which project(s) to import.

**If "Specific plans"**: Display a numbered list of new plans (format: `N. [YYYY-MM-DD HH:MM AM] [project/name] Title`). Ask the user which numbers they want (comma-separated). Map their selections back to `sourceSlug` values.

### 4. Ask summarization preference

Use `AskUserQuestion` with these options:

- **AI summaries (Claude Haiku)** — Richer, more descriptive summaries (uses API calls)
- **Fast text extraction** — Quick summaries from plan content, no API calls

### 5. Dry run

Execute the script with `--dry-run` and the appropriate filters:

```bash
# All new plans
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --all --dry-run [--skip-summarize] 2>/dev/null

# Date range
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --all --from=YYYY-MM-DD --to=YYYY-MM-DD --dry-run [--skip-summarize] 2>/dev/null

# By project
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --all --project=project-name --dry-run [--skip-summarize] 2>/dev/null

# Specific plans
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --plans=slug1,slug2,slug3 --dry-run [--skip-summarize] 2>/dev/null
```

Add `--skip-summarize` if the user chose fast text extraction.

Parse the JSON result and display a summary: "Will import N plans, M will be skipped (already imported), E errors."

If there are errors, show them to the user.

### 6. Confirm

Use `AskUserQuestion` to confirm:

- **Proceed** — Import the plans and create journal entries
- **Cancel** — Abort without changes

### 7. Execute

Run the same command without `--dry-run`:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backport-journal.ts --all [--skip-summarize] 2>/dev/null
```

Parse the JSON result and display the final report: "Imported N plans. M skipped. E errors."

If there were errors, list them for the user.
