# Skill-Aware Session Capture

## Problem

The capture-plan plugin only captures sessions that go through plan mode (ExitPlanMode hook) or write superpowers spec/plan files. Skills like `/simplify` run autonomous agents that review and improve code, but their activity is never captured to Obsidian because they don't trigger either capture path. All analysis, tool usage, subagent prompts, and outcomes are lost.

## Goal

Detect when any plugin skill runs during a session and capture the full activity to Obsidian — summary, files changed, tool log, subagent prompts, and token stats — using the same infrastructure that plan-mode and superpowers sessions already use.

## Approach: Transcript Scanning at Stop

Extend the existing Stop hook (`capture-done.ts`) to scan the transcript for `Skill` tool_use blocks. When skills are detected and no plan-mode or superpowers session state exists, the hook creates a session directory, summarizes the activity with Claude Haiku, and writes the full note suite.

This mirrors how `findSuperpowersWrites()` already scans for `Write` tool_use blocks targeting spec/plan paths.

## Data Structures

### SkillInvocation (new, in transcript.ts)

```ts
interface SkillInvocation {
  index: number;          // Transcript entry index
  skill: string;          // Skill name, e.g., "simplify"
  args?: string;          // Optional args passed to the skill
  contextBefore: string;  // Assistant text from the turn containing the Skill call
  contextAfter: string;   // Assistant text from the immediate next assistant turn after the skill completes
}
```

### SessionState (extended, in types.ts)

```ts
export interface SessionState {
  // ... existing fields unchanged ...
  source?: "plan-mode" | "superpowers" | "skill";
  skill_name?: string;   // Primary skill name for skill-sourced sessions
  spec_path?: string;     // Existing field, unchanged
}
```

## Detection: findSkillInvocations()

New function in `transcript.ts`:

- Scans all transcript entries for `tool_use` blocks where `name === "Skill"`
- Extracts `input.skill` as the skill name, `input.args` as optional arguments
- Captures surrounding assistant text from the same turn (contextBefore) and the next assistant turn (contextAfter)
- Returns `SkillInvocation[]`

Filtering: All skill invocations are captured. No allowlist/blocklist — every skill from every plugin is detected.

## Capture Flow

### Stop hook decision tree (capture-done.ts main())

```
1. Existing session state found?
   ├── yes (plan-mode) → existing plan-mode flow
   ├── yes (superpowers) → existing superpowers flow
   └── no → continue to detection

2. Superpowers writes in transcript?
   ├── yes → existing superpowers detection flow
   └── no → continue

3. Skill invocations in transcript?  ← NEW
   ├── yes → buildSkillState() → write notes
   └── no → exit (nothing to capture)
```

### Pre-check optimization

Before full transcript parsing, do a cheap string scan (like `transcriptContainsPattern`) looking for `"Skill"` in the raw JSONL. Exit early if not found.

## buildSkillState() Function

Analogous to `buildSuperpowersState()`. Steps:

1. **Select primary skill**: Use the first skill invocation as the primary (used for boundary detection)
2. **Set boundary**: The first `SkillInvocation.index` marks the planning/execution split
3. 
4. **Build narrative**: Concatenate contextBefore + contextAfter from all skill invocations
5. **Summarize with Haiku**: Send narrative to Claude Haiku for AI-generated title and summary. Use a system prompt tailored for skill sessions:
   ```
   You are a concise note-taking assistant. Given context about a coding session
   where automated skills were used, output exactly two lines:
   Line 1: A 1-2 sentence summary (max 200 chars). Include what skills ran and
   their concrete outcomes.
   Line 2: 1-2 lowercase kebab-case tags (comma-separated, no # prefix).
   ```
6. **Create directory**: `<skills.path>/<date_scheme_path>/NNN-<slug>/` — skill-only sessions land under `config.skills.path`, not `config.plan.path`.
7. **Write activity.md**: Primary note with frontmatter and skill activity
8. **Journal entry**: Append to daily journal
9. **Return SessionState**: With `source: "skill"`, `skill_name: <primary>`

## Note Structure

### Directory layout (skill-only session)

```
Claude/Skills/2026/04-03/001-simplify-capture-plan/
├── activity.md      # Primary note (AI-generated title, skill context)
├── summary.md       # Execution summary (files changed, outcomes)
├── tools-stats.md   # Token stats, tool usage, duration
├── tools-log.md     # Chronological tool log
└── agents/          # Subagent prompt files
    ├── agent-001-code-simplifier.md
    └── ...
```

### activity.md format

```markdown
---
created: "[[Journal/2026/04-03|2026-04-03 2:30 PM]]"
project: capture-plan
tags:
  - simplify
  - code-quality
session: "[[Sessions/abc123]]"
cc_version: "1.2.3"
model: claude-opus-4-6
source: skill
skills:
  - simplify
---
# Simplify and Improve Capture-Plan Hooks

## Skills Used

| Time | Skill | Args |
|------|-------|------|
| 2:30 PM | simplify | — |

## Context

[Assistant text surrounding skill invocations — why it was run, what it found]
```

### Mixed sessions (plan + skills)

When a session has both a plan AND skill invocations:

- **Plan capture works unchanged** (plan.md created by capture-plan.ts hook)
- At Stop time, skills are detected and written as **additional notes in the same directory**
- Each skill gets its own note named after the skill: `simplify.md`, `debugging.md`
- The `summary.md` references both the plan and skill activity
- `tools-log.md` captures all tool activity across the full session

The existing execution summary flow handles the plan. The new skill detection adds companion notes without disrupting it.

### Path separation

- **Skill-only sessions** → notes written under `config.skills.path` (default `Claude/Skills`). Skill counters are scoped to this root and are independent from plan counters.
- **Mixed sessions** (plan mode + skill invocation) → per-skill companion notes remain inside the plan's `plan_dir` (under `config.plan.path`), so summary wikilinks continue to resolve correctly. This behavior is unchanged.
- **Counters are per-root**: incrementing a skill counter does not affect the plan counter and vice versa.

## Files to Modify

| File | Change |
|------|--------|
| `hooks/transcript.ts` | Add `SkillInvocation` interface, `findSkillInvocations()` function |
| `hooks/lib/types.ts` | Extend `SessionState.source` union, add `skill_name` field |
| `hooks/capture-done.ts` | Add skill detection path in `main()`, add `buildSkillState()` |
| `hooks/lib/session-state.ts` | Handle `skill_name` in serialization/deserialization (if needed) |

## Files to Add

| File | Purpose |
|------|---------|
| `hooks/__tests__/skill-capture.test.ts` | Tests for skill detection and capture flow |

## Testing

### Unit tests (skill-capture.test.ts)

- `findSkillInvocations()` finds Skill tool_use blocks in transcript entries
- `findSkillInvocations()` extracts skill name, args, and surrounding text
- `findSkillInvocations()` returns empty array when no skills used
- `findSkillInvocations()` handles multiple skill invocations in one session
- `buildSkillState()` creates correct directory structure and note content
- `buildSkillState()` handles mixed plan + skill sessions
- Pre-check pattern scan detects "Skill" in raw JSONL

### End-to-end verification

1. Run `/simplify` in a session on this repo
2. End the session (Stop hook fires)
3. Check Obsidian vault for:
   - `activity.md` under `config.skills.path` (e.g. `Claude/Skills/…`) — **not** under `Claude/Plans`
   - Path built via `getSkillDatePath()` using the `[skills]` config table
   - `summary.md` with files changed
   - `tools-stats.md` and `tools-log.md` with full stats
   - Journal entry linking to the activity note
4. Run a mixed session (plan + /simplify) and verify both `plan.md` and `simplify.md` appear in the same directory under `config.plan.path`

## Out of Scope

- Per-skill configuration (detail level, inclusion/exclusion) — YAGNI for now
- Real-time capture during skill execution (PostToolUse hook approach)
- Skill-specific note templates or formatting
