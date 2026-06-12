---
name: backfill-frontmatter-estimation
description: Estimate the scope and runtime of the frontmatter backfill — hardware specs, vault size, pending upgrades, and a calibrated time estimate. Read-only; nothing is modified.
---

# Backfill Frontmatter — Estimation

Produce a read-only estimate of what `/backfill-frontmatter` would do on this machine and vault.

## Procedure

### 1. Run the estimator

```bash
bun ${CLAUDE_PLUGIN_ROOT}/hooks/backfill-estimate.ts --cwd "$(pwd)"
```

The script reports:

- **Hardware** — CPU model, core count, memory, the worker concurrency the backfill would use, and a live-calibrated Obsidian CLI round-trip latency
- **Vault** — which trees are scanned, file count, and total size of plugin-generated content
- **Pending work** — how many notes need upgrading, broken down by frontmatter field and by doc type
- **Estimated runtime** — calibrated to this machine, with an uncertainty range

### 2. Present the report

Relay the report to the user in full, lightly formatted. Then:

- If **nothing is pending**, tell the user the vault is already at the current frontmatter standard — no backfill needed.
- Otherwise, summarize in one sentence (e.g., "About 6,300 notes need upgrading; expect roughly 2–6 minutes.") and suggest running `/backfill-frontmatter` to apply.

## Notes

- The estimator never modifies the vault. Calibration uses a few metadata-only CLI queries.
- If the script reports it cannot resolve the vault path, verify the Obsidian app is running and `vault` is set in the capture-plan config.
