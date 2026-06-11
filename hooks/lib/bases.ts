// bases.ts — Plugin-managed Obsidian Bases (.base database views over captured notes)
//
// The plugin is the authority for these files: on every sync, each vault .base
// is compared against the canonical definition and replaced when it differs,
// discarding any manual adjustments. Users opt out via `[bases] enabled = false`.

import { createVaultNote, runObsidian } from "./obsidian.ts"
import { debugLog } from "./text.ts"
import type { Config } from "./types.ts"

/** Version of the managed base definitions. Bump when definitions change so
 *  per-session hint gating re-syncs after a plugin update. */
export const BASES_VERSION = 1

/** Comment header stamped on every managed .base file. Obsidian strips YAML
 *  comments when it rewrites the file from the UI, so a missing header also
 *  marks the file as drifted and forces a restore. */
const MANAGED_HEADER = `# Managed by the capture-plan plugin — do not edit.
# Manual changes are replaced on the next sync (session start).
# To customize, copy this file under another name, or set
# \`enabled = false\` under [bases] in capture-plan.toml.
`

/** A canonical .base file managed by the plugin. */
export interface BaseDefinition {
  /** Vault-relative path including the .base extension. */
  path: string
  /** Canonical YAML content. */
  content: string
}

/** Filter block excluding e2e-test artifacts from plan-tree bases. */
const E2E_EXCLUDE = `    - not:
        - file.path.contains("e2e-test")
        - file.path.contains("test-project-")`

/** Build the runs dashboard base: one row per executed plan (tools-stats notes).
 *  Views that sort by file.path also display it — Obsidian silently ignores a
 *  sort whose property is not among the view's columns. */
function buildRunsBase(planPath: string): string {
  const runColumns = `    order:
      - note.plan
      - note.project
      - note.model
      - note.duration
      - note.tokens_in
      - note.tokens_out
      - note.context_pct
      - note.subagents
      - note.tools_used
      - note.total_errors
      - file.path
    summaries:
      note.tokens_in: Sum
      note.tokens_out: Sum
      note.tools_used: Sum
      note.total_errors: Sum`
  return `${MANAGED_HEADER}filters:
  and:
    - file.inFolder("${planPath}")
    - file.name == "tools-stats"
${E2E_EXCLUDE}
formulas:
  total_tokens: tokens_in + tokens_out
properties:
  note.plan:
    displayName: Plan
  note.project:
    displayName: Project
  note.model:
    displayName: Model
  note.duration:
    displayName: Duration
  note.tokens_in:
    displayName: Tokens in
  note.tokens_out:
    displayName: Tokens out
  formula.total_tokens:
    displayName: Tokens (total)
  note.context_pct:
    displayName: Ctx %
  note.subagents:
    displayName: Subagents
  note.tools_used:
    displayName: Tool calls
  note.total_errors:
    displayName: Errors
  file.path:
    displayName: Path
views:
  - type: table
    name: Recent runs
    limit: 100
    sort:
      - property: file.path
        direction: DESC
${runColumns}
  - type: table
    name: By project
    groupBy:
      property: note.project
      direction: ASC
    sort:
      - property: file.path
        direction: DESC
${runColumns}
  - type: table
    name: Heaviest runs
    limit: 25
    sort:
      - property: formula.total_tokens
        direction: DESC
    order:
      - note.plan
      - note.project
      - formula.total_tokens
      - note.tokens_in
      - note.tokens_out
      - note.duration
      - note.context_pct
  - type: table
    name: High context pressure
    filters:
      and:
        - note.context_pct >= 20
    sort:
      - property: note.context_pct
        direction: DESC
    order:
      - note.plan
      - note.project
      - note.context_pct
      - note.model
      - note.tokens_in
      - note.tokens_out
  - type: table
    name: Runs with errors
    filters:
      and:
        - note.total_errors > 0
    sort:
      - property: file.path
        direction: DESC
    order:
      - note.plan
      - note.project
      - note.total_errors
      - note.tools_used
      - note.duration
      - file.path
`
}

/** Build the plans index base: one row per captured plan note. */
function buildPlansBase(planPath: string): string {
  return `${MANAGED_HEADER}filters:
  and:
    - file.inFolder("${planPath}")
    - file.name == "plan"
${E2E_EXCLUDE}
formulas:
  run: file.folder.split("/").reverse()[0]
properties:
  formula.run:
    displayName: Run
  note.project:
    displayName: Project
  note.date:
    displayName: Date
  note.source:
    displayName: Source
  note.session:
    displayName: Session
  note.tags:
    displayName: Tags
  file.path:
    displayName: Path
views:
  - type: table
    name: All plans
    limit: 200
    sort:
      - property: file.path
        direction: DESC
    order:
      - formula.run
      - note.project
      - note.date
      - note.source
      - note.session
      - note.tags
      - file.path
  - type: table
    name: By project
    groupBy:
      property: note.project
      direction: ASC
    sort:
      - property: file.path
        direction: DESC
    order:
      - formula.run
      - note.date
      - note.source
      - note.tags
      - file.path
  - type: table
    name: Superpowers
    filters:
      and:
        - note.source == "superpowers"
    sort:
      - property: file.path
        direction: DESC
    order:
      - formula.run
      - note.project
      - note.date
      - note.spec_file
      - file.path
`
}

/** Build the subagent dispatch base: one row per agent prompt note. */
function buildAgentsBase(planPath: string): string {
  return `${MANAGED_HEADER}filters:
  and:
    - file.inFolder("${planPath}")
    - file.hasProperty("subagent_type")
${E2E_EXCLUDE}
properties:
  note.description:
    displayName: Task
  note.subagent_type:
    displayName: Agent type
  note.model:
    displayName: Model
  note.tokens_in:
    displayName: Tokens in
  note.tokens_out:
    displayName: Tokens out
  note.duration:
    displayName: Duration
  note.plan:
    displayName: Plan
  file.path:
    displayName: Path
views:
  - type: table
    name: Recent dispatches
    limit: 200
    sort:
      - property: file.path
        direction: DESC
    order:
      - note.description
      - note.subagent_type
      - note.model
      - note.tokens_in
      - note.tokens_out
      - note.duration
      - note.plan
      - file.path
  - type: table
    name: By agent type
    groupBy:
      property: note.subagent_type
      direction: ASC
    sort:
      - property: file.path
        direction: DESC
    order:
      - note.description
      - note.model
      - note.plan
      - file.path
  - type: table
    name: By model
    groupBy:
      property: note.model
      direction: ASC
    sort:
      - property: file.path
        direction: DESC
    order:
      - note.description
      - note.subagent_type
      - note.plan
      - file.path
`
}

/** Build the sessions overview base: one row per session document. */
function buildSessionsBase(sessionPath: string): string {
  return `${MANAGED_HEADER}filters:
  and:
    - file.inFolder("${sessionPath}")
properties:
  file.name:
    displayName: Session
  note.project:
    displayName: Project
  note.started:
    displayName: Started
  note.model:
    displayName: Model
  note.mode:
    displayName: Mode
  note.plans:
    displayName: Plans
  note.summaries:
    displayName: Summaries
  note.activities:
    displayName: Activities
views:
  - type: table
    name: Recent sessions
    limit: 100
    sort:
      - property: note.started
        direction: DESC
    order:
      - file.name
      - note.project
      - note.started
      - note.model
      - note.mode
      - note.plans
      - note.summaries
      - note.activities
  - type: table
    name: By project
    groupBy:
      property: note.project
      direction: ASC
    sort:
      - property: note.started
        direction: DESC
    order:
      - file.name
      - note.started
      - note.model
      - note.plans
      - note.summaries
`
}

/** Build the journal base: one row per daily journal note. */
function buildJournalBase(journalPath: string): string {
  return `${MANAGED_HEADER}filters:
  and:
    - file.inFolder("${journalPath}")
    - file.hasProperty("date")
properties:
  file.name:
    displayName: Day
  note.date:
    displayName: Date
  note.day:
    displayName: Weekday
  note.plans:
    displayName: Plans
  note.projects:
    displayName: Projects
  note.tags:
    displayName: Tags
views:
  - type: table
    name: Daily journal
    limit: 120
    sort:
      - property: note.date
        direction: DESC
    order:
      - file.name
      - note.date
      - note.day
      - note.plans
      - note.projects
      - note.tags
    summaries:
      note.plans: Sum
`
}

/** Build the canonical set of managed .base files for the given config.
 *  Pure function of the config paths — used both for syncing and in tests. */
export function buildBaseDefinitions(config: Config): BaseDefinition[] {
  const dir = config.bases.path
  return [
    { path: `${dir}/claude-runs.base`, content: buildRunsBase(config.plan.path) },
    { path: `${dir}/claude-plans.base`, content: buildPlansBase(config.plan.path) },
    { path: `${dir}/claude-agents.base`, content: buildAgentsBase(config.plan.path) },
    { path: `${dir}/claude-sessions.base`, content: buildSessionsBase(config.session.path) },
    { path: `${dir}/claude-journal.base`, content: buildJournalBase(config.journal.path) },
  ]
}

/** Minimal vault IO surface used by syncBases, injectable for tests. */
export interface BasesIo {
  /** Read a vault file verbatim (any extension). Returns null when missing or unreadable. */
  read(pathRel: string, vault?: string): string | null
  /** Create or overwrite a vault file. Returns true on success. */
  write(pathRel: string, content: string, vault?: string): boolean
}

/** Default IO backed by the Obsidian CLI. The CLI handles non-.md extensions
 *  (verified for .base): `read` returns content verbatim and `create` with the
 *  `overwrite` flag replaces the file without disturbing the vault index. */
const defaultIo: BasesIo = {
  read(pathRel, vault) {
    const result = runObsidian(["read", `path=${pathRel}`], vault)
    return result.exitCode === 0 ? result.stdout : null
  },
  write(pathRel, content, vault) {
    return createVaultNote(pathRel, content, vault).success
  },
}

/** Outcome of a syncBases run. */
export interface SyncBasesResult {
  /** True when the sync ran to completion (bases enabled, no fatal error). */
  synced: boolean
  /** Vault paths of .base files that were created or replaced. */
  written: string[]
}

/** Reconcile the vault's managed .base files with their canonical definitions.
 *  Files that match are left untouched; missing or manually-modified files are
 *  (re)created via the Obsidian CLI. Never throws — hooks call this
 *  opportunistically and must not fail because of base management. */
export function syncBases(
  config: Config,
  debugLogPath?: string,
  io: BasesIo = defaultIo,
): SyncBasesResult {
  const written: string[] = []
  if (!config.bases.enabled) return { synced: false, written }
  try {
    for (const def of buildBaseDefinitions(config)) {
      const existing = io.read(def.path, config.vault)
      if (existing !== null && existing.trim() === def.content.trim()) continue
      if (io.write(def.path, def.content, config.vault)) {
        written.push(def.path)
      } else if (debugLogPath) {
        debugLog(`syncBases: failed to write ${def.path}\n`, debugLogPath)
      }
    }
    return { synced: true, written }
  } catch (err) {
    if (debugLogPath) debugLog(`syncBases error: ${err}\n`, debugLogPath)
    return { synced: false, written }
  }
}
