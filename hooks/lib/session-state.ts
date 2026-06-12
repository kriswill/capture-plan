// session-state.ts — Session state persistence and plan frontmatter parsing

import type { TranscriptStats } from "../transcript.ts"
import type { DateScheme } from "./dates.ts"
import { formatDatePath, getDatePartsFor } from "./dates.ts"
import { createVaultNote, listVaultFolders, readVaultNote, runObsidian } from "./obsidian.ts"
import { ensureMdExt } from "./text.ts"
import type { Config, ContextHint, PathConfig, PlanFrontmatter, SessionState } from "./types.ts"

const STALE_STATE_MS = 2 * 60 * 60 * 1000 // 2 hours

/** Parse a SessionState from the YAML frontmatter of a vault state note. Returns null if missing or malformed. */
export function parseStateFromFrontmatter(content: string): SessionState | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return null
  const fm = fmMatch[1]

  const get = (key: string): string | undefined => {
    // Quoted value: key: "value" (legacy manual serialization)
    const quoted = fm.match(new RegExp(`^${key}:\\s*"(.*)"\\s*$`, "m"))
    if (quoted) return quoted[1]
    // Unquoted value: key: value (Obsidian property:set format)
    const unquoted = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
    return unquoted ? unquoted[1].trim() : undefined
  }

  const sessionId = get("session_id")
  const planSlug = get("plan_slug")
  const planTitle = get("plan_title")
  const planDir = get("plan_dir")
  const dateKey = get("date_key")
  const timestamp = get("timestamp")
  if (!sessionId || !planSlug || !planTitle || !planDir || !dateKey || !timestamp) return null

  const state: SessionState = {
    session_id: sessionId,
    plan_slug: planSlug,
    plan_title: planTitle.replace(/\\"/g, '"'),
    plan_dir: planDir,
    date_key: dateKey,
    timestamp,
    journal_path: get("journal_path"),
    project: get("project"),
    tags: get("tags"),
    model: get("model"),
    cc_version: get("cc_version"),
    source: get("source") as SessionState["source"],
    spec_path: get("spec_path"),
    skill_name: get("skill_name"),
  }

  const completedRaw = get("completed")
  if (completedRaw === "true") state.completed = true

  const statsJson = get("plan_stats_json")
  if (statsJson) {
    try {
      state.planStats = JSON.parse(statsJson) as TranscriptStats
    } catch {
      try {
        // Legacy format stored escaped quotes inside YAML double-quoted strings
        state.planStats = JSON.parse(statsJson.replace(/\\"/g, '"')) as TranscriptStats
      } catch {
        /* ignore malformed stats */
      }
    }
  }

  return state
}

/** Persist session state as a frontmatter-only vault note for the Stop hook to discover. */
export function writeVaultState(state: SessionState, vault?: string): boolean {
  const lines: string[] = ["---"]
  const props: [string, string | undefined][] = [
    ["session_id", state.session_id],
    ["plan_slug", state.plan_slug],
    ["plan_title", state.plan_title],
    ["plan_dir", state.plan_dir],
    ["date_key", state.date_key],
    ["timestamp", state.timestamp],
    ["journal_path", state.journal_path],
    ["project", state.project],
    ["tags", state.tags],
    ["model", state.model],
    ["cc_version", state.cc_version],
    ["source", state.source],
    ["spec_path", state.spec_path],
    ["skill_name", state.skill_name],
    ["completed", state.completed ? "true" : undefined],
  ]
  for (const [name, value] of props) {
    if (value) lines.push(`${name}: ${value}`)
  }
  if (state.planStats) {
    lines.push(`plan_stats_json: ${JSON.stringify(state.planStats)}`)
  }
  lines.push("---")
  return createVaultNote(`${state.plan_dir}/state`, lines.join("\n"), vault).success
}

/**
 * Resolve the pending SessionState for a Stop hook.
 *
 * Prefers the `plan_dir` hint written by capture-plan (single CLI read) and falls back
 * to a full vault scan when the hint is absent (pre-hint sessions, or sessions with no
 * captured plan). Returns null when no uncompleted state belonging to this session
 * exists in the vault.
 */
export function resolveVaultState(
  sessionId: string,
  mainHint: ContextHint | null | undefined,
  config: Config,
): SessionState | null {
  if (mainHint?.plan_dir) {
    const stateText = readVaultNote(`${mainHint.plan_dir}/state`, config.vault)
    if (!stateText) return null
    const parsed = parseStateFromFrontmatter(stateText)
    if (!parsed || parsed.completed || parsed.session_id !== sessionId) return null
    return parsed
  }
  return scanForVaultState(sessionId, config)
}

/** Return the vault root paths to scan for session state files (plan and skills). */
function stateRoots(config: Config): PathConfig[] {
  return [config.plan, config.skills]
}

/**
 * Yield each unique `${root.path}/${dateSeg}` folder for plan and skills roots across
 * today and yesterday. Dedupes when plan and skills resolve to the same date folder
 * so we don't list/read each state.md twice.
 */
function* uniqueStateDateFolders(config: Config): Generator<string> {
  const seen = new Set<string>()
  for (const root of stateRoots(config)) {
    for (const dateSeg of recentDateSegmentsFor(root.date_scheme)) {
      const dateFolder = `${root.path}/${dateSeg}`
      if (seen.has(dateFolder)) continue
      seen.add(dateFolder)
      yield dateFolder
    }
  }
}

/** Scan today's and yesterday's plan and skills directories for a matching session state file. */
export function scanForVaultState(sessionId: string, config: Config): SessionState | null {
  let match: SessionState | null = null

  for (const dateFolder of uniqueStateDateFolders(config)) {
    const planDirs = listVaultFolders(dateFolder, config.vault)

    for (const dirName of planDirs) {
      const stateRel = `${dateFolder}/${dirName}/state`
      const text = readVaultNote(stateRel, config.vault)
      if (!text) continue

      const state = parseStateFromFrontmatter(text)
      if (!state || state.completed) continue

      // Skip stale states (>2h) but don't delete here — cleanup runs separately
      const age = Date.now() - new Date(state.timestamp).getTime()
      if (age > STALE_STATE_MS) continue

      if (state.session_id === sessionId) {
        match = state
      }
    }
  }

  return match
}

/** Delete stale (>2h) uncompleted state files from today's and yesterday's plan and skills directories. */
export function cleanupStaleStates(config: Config): void {
  for (const dateFolder of uniqueStateDateFolders(config)) {
    const planDirs = listVaultFolders(dateFolder, config.vault)

    for (const dirName of planDirs) {
      const stateRel = `${dateFolder}/${dirName}/state`
      const text = readVaultNote(stateRel, config.vault)
      if (!text) continue

      const state = parseStateFromFrontmatter(text)
      if (!state || state.completed) continue

      const age = Date.now() - new Date(state.timestamp).getTime()
      if (age > STALE_STATE_MS) {
        runObsidian(["delete", `path=${dateFolder}/${dirName}/state.md`, "permanent"], config.vault)
      }
    }
  }
}

/** Return date path segments for today and yesterday (covers midnight crossover) using the given scheme. */
function recentDateSegmentsFor(scheme: DateScheme): string[] {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  return [today, yesterday].map((d) => {
    const parts = getDatePartsFor(d)
    return formatDatePath(scheme, parts)
  })
}

/** Remove the state.md file from a plan directory after the Stop hook has consumed it. */
export function deleteVaultState(planDir: string, vault?: string): void {
  runObsidian(["delete", `path=${planDir}/state.md`, "permanent"], vault)
}

/** Mark a state.md as completed by rewriting it with the completed flag set. */
export function markVaultStateCompleted(state: SessionState, vault?: string): boolean {
  return writeVaultState({ ...state, completed: true }, vault)
}

/** Extract structured fields (created, tags, counter, etc.) from a plan note's YAML frontmatter. */
export function parsePlanFrontmatter(content: string): PlanFrontmatter {
  const result: PlanFrontmatter = {}
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fmMatch) return result
  const fm = fmMatch[1]

  // created: "[[Journal/path|datetime]]"
  const createdMatch = fm.match(/^created:\s*"?\[\[([^|]+)\|([^\]]+)\]\]"?/m)
  if (createdMatch) {
    result.created = `[[${createdMatch[1]}|${createdMatch[2]}]]`
    result.journalPath = createdMatch[1]
    result.datetime = createdMatch[2]
  }

  // status
  const statusMatch = fm.match(/^status:\s*(.+)/m)
  if (statusMatch) result.status = statusMatch[1].trim()

  // counter
  const counterMatch = fm.match(/^counter:\s*(\d+)/m)
  if (counterMatch) result.counter = parseInt(counterMatch[1], 10)

  // session
  const sessionMatch = fm.match(/^session:\s*(.+)/m)
  if (sessionMatch) result.session = sessionMatch[1].trim()

  // project
  const projectMatch = fm.match(/^project:\s*(.+)/m)
  if (projectMatch) result.project = projectMatch[1].trim()

  // source_slug (for backport dedup)
  const sourceSlugMatch = fm.match(/^source_slug:\s*(.+)/m)
  if (sourceSlugMatch) result.source_slug = sourceSlugMatch[1].trim()

  // tags (YAML list format)
  const tagsSection = fm.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m)
  if (tagsSection) {
    result.tags = tagsSection[1]
      .split("\n")
      .map((l) => l.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean)
  }

  return result
}

/** Append a revision bullet to an existing callout block with the given title in the journal file.
 *  Reads the file directly (safe for vault index), but writes back via Obsidian CLI to keep the vault in sync. */
export async function appendRevisionToCallout(
  planTitle: string,
  revision: string,
  journalFilePath: string,
  journalRelPath: string,
  vault?: string,
): Promise<boolean> {
  try {
    const content = await Bun.file(journalFilePath).text()
    const lines = content.split("\n")

    // Find > [!plan]+ {title} header
    const headerPattern = `> [!plan]+ ${planTitle}`
    let headerIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === headerPattern) {
        headerIdx = i
        break
      }
    }
    if (headerIdx === -1) return false

    // Find the last line starting with ">" in this callout block
    let lastCalloutLine = headerIdx
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith(">")) break
      lastCalloutLine = i
    }

    // Insert the new revision lines after the last callout line
    const revisionLines = revision.split("\n")
    lines.splice(lastCalloutLine + 1, 0, ...revisionLines)

    // Write back via Obsidian CLI (createVaultNote handles delete-before-create)
    createVaultNote(ensureMdExt(journalRelPath), lines.join("\n"), vault)
    return true
  } catch {
    return false
  }
}
