---
name: backfill-frontmatter
description: Upgrade existing vault notes to the current frontmatter standard (type, date, duration_s, normalized model + context_window) so they appear in the managed Obsidian bases. Interruptible and resumable.
---

# Backfill Frontmatter

Upgrade legacy notes captured by this plugin to the current frontmatter standard. All data is derived from the notes themselves (frontmatter and vault paths) — Claude Code session files are never read. Note bodies are untouched; only the frontmatter block changes.

## Procedure

### 1. Scope the work

Run a dry-run first to see what would change:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backfill-frontmatter.ts --dry-run --cwd "$(pwd)"
```

Report the scan line to the user (files scanned, notes needing upgrades, change breakdown).

- If **0 need upgrades**, tell the user the vault is already at the current standard and stop.
- If more than ~1,000 notes need upgrading and the user has not already seen an estimate, mention they can run `/backfill-frontmatter-estimation` for a runtime estimate — but since they invoked this command imperatively, proceed unless they object.

### 2. Run the backfill in the background

Launch with `run_in_background` so progress can be reported while it works:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backfill-frontmatter.ts --cwd "$(pwd)"
```

The script prints a progress line every 100 notes with the current rate and ETA (e.g., `backfill: 1200/6336 (45/s, ~1m 54s remaining)`), and the same lines go to `/tmp/capture-backfill-debug.log`.

While it runs, periodically Read the background task's output and relay the latest progress line to the user (roughly every 15–30 seconds, or when they ask).

### 3. Interruption

If the user asks to stop, send SIGTERM to the process (`pkill -f "bun .*backfill-frontmatter"` or stop the background task). The script finishes in-flight writes, prints how far it got, and exits. Tell the user the run is **resumable**: re-running this command skips every note that is already upgraded and continues with the rest.

### 4. Completion

When the script finishes, report the final summary line: notes rewritten, property-fallback count, failures, and elapsed time. If there were failures, list them (the script prints up to 20) and suggest re-running — failures are retried on the next run since those notes still won't be at spec.

Optionally verify by re-running the dry-run from step 1: it should report `0 need upgrades`.

## Notes

- Safe to re-run any number of times — conformant notes cost zero writes.
- A hung Obsidian CLI call is killed after 15s and counted as a failure rather than blocking the run.
- The Obsidian app must be running (writes go through the Obsidian CLI).
