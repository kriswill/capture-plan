---
name: config-print
description: Display all configuration options with their effective value and which config layer set them.
---

# Print Configuration

Display every capture-plan config option, its current effective value, and which layer provided it.

## Procedure

### 1. Run the config printer

```bash
CLAUDE_CWD="$PWD" bun ${CLAUDE_PLUGIN_ROOT}/hooks/print-config.ts
```

Parse the JSON output. It contains:
- `options` — array of objects with `key`, `value`, and `source`
- `configPaths` — object with `plugin`, `user`, and `project` file paths (resolved for the current platform)
- `warnings` — optional array of `{ key, table, layer }` entries flagging top-level scalar keys found scoped under a nested table (typically a TOML placement bug — the value is still recovered)

### 2. Display results

Render a markdown table with these columns:

| Option | Value | Source |
|--------|-------|--------|

For each entry in `options`:
- **Option** — the dotted key name (e.g. `plan.path`)
- **Value** — the effective value. Format arrays as comma-separated. Show `(not set)` for null values.
- **Source** — one of: `default`, `plugin`, `user`, `project`

### 3. Show config file paths

After the table, extract and display the resolved paths from the JSON response under `configPaths`:

```json
"configPaths": {
  "plugin": "...",
  "user": "...",
  "project": "..."
}
```

Display as:
- **Plugin default:** `configPaths.plugin`
- **User global:** `configPaths.user` (auto-resolved for the current platform)
- **Project local:** `configPaths.project` (or `(not set)` if outside a project)

### 4. Show warnings (if any)

If `warnings` is present and non-empty, render a `## Warnings` section after the paths. For each entry, display:

```
- `<key>` found under `[<table>]` in <layer> TOML — value was recovered to top level. Move the key out of the table to silence this warning.
```

Skip the section entirely when `warnings` is absent or empty.
