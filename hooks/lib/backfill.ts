// backfill.ts — Pure logic for upgrading legacy vault notes to the current
// frontmatter standard (type, date, duration_s, normalized model + context_window).
//
// Derivations use only data already present in the note (frontmatter fields)
// or its vault path — never Claude Code session files, which may no longer exist.

import { durationSeconds } from "./dates.ts"
import { normalizeModelId } from "./text.ts"

/** Doc types the backfill can classify and upgrade. */
export type BackfillDocType =
  | "plan"
  | "summary"
  | "tools-stats"
  | "tools-log"
  | "agent"
  | "activity"
  | "spec"
  | "skill"
  | "session"
  | "journal"

/** Vault-relative root folders that scope classification. */
export interface BackfillPaths {
  planPath: string
  journalPath: string
  sessionPath: string
}

const KNOWN_BASENAMES: Record<string, BackfillDocType> = {
  "plan.md": "plan",
  "summary.md": "summary",
  "tools-stats.md": "tools-stats",
  "tools-log.md": "tools-log",
  "activity.md": "activity",
  "spec.md": "spec",
  // Ancestral name for tools-stats.md (renamed 2026-04-01)
  "plan-tools.md": "tools-stats",
}

/** Internal bridge/test artifacts that must never be touched. */
const SKIP_BASENAMES = new Set(["state.md", "test-log.md"])

/** Path fragments marking e2e-test artifacts (mirrors the bases exclusion). */
const SKIP_PATH_FRAGMENTS = ["e2e-test", "test-project-"]

/** Classify a vault-relative file path into a backfillable doc type.
 *  Returns null for files the backfill must leave alone (unknown names,
 *  internal state, e2e artifacts, non-markdown). A "skill" result is a
 *  candidate only — upgradeNoteContent verifies `source: skill` before
 *  touching the file. */
export function classifyDoc(relPath: string, paths: BackfillPaths): BackfillDocType | null {
  if (!relPath.endsWith(".md")) return null
  if (SKIP_PATH_FRAGMENTS.some((frag) => relPath.includes(frag))) return null
  const base = relPath.split("/").pop() ?? ""
  if (SKIP_BASENAMES.has(base)) return null

  if (relPath.startsWith(`${paths.sessionPath}/`)) return "session"
  if (relPath.startsWith(`${paths.journalPath}/`)) return "journal"
  if (relPath.startsWith(`${paths.planPath}/`)) {
    const known = KNOWN_BASENAMES[base]
    if (known) return known
    const segments = relPath.split("/")
    if (segments[segments.length - 2] === "agents") return "agent"
    return "skill"
  }
  return null
}

/** Parse a human-readable duration display string ("3m 5s", "1h 5m", "122.6s",
 *  "850ms") into whole seconds. Returns null when nothing parseable is found. */
export function parseDurationToSeconds(display: string): number | null {
  let totalMs = 0
  let matched = false
  for (const m of display.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    const value = Number.parseFloat(m[1])
    matched = true
    if (m[2] === "ms") totalMs += value
    else if (m[2] === "s") totalMs += value * 1_000
    else if (m[2] === "m") totalMs += value * 60_000
    else totalMs += value * 3_600_000
  }
  return matched ? durationSeconds(totalMs) : null
}

/** Parse a context window size from a legacy model suffix in either style:
 *  "claude-opus-4-8 (1M)" or "claude-opus-4-8[1m]". Returns undefined when
 *  no suffix is present. */
export function parseModelContextWindow(model: string): number | undefined {
  const match = model.match(/[([]\s*(\d+)\s*([km])\s*[)\]]/i)
  if (!match) return undefined
  const num = Number(match[1])
  return match[2].toLowerCase() === "m" ? num * 1_000_000 : num * 1_000
}

/** Derive a scalar YYYY-MM-DD date from frontmatter (created wikilink alias,
 *  then started timestamp) or from date-scheme segments in the vault path. */
export function deriveDate(fmText: string, relPath: string): string | null {
  const created = fmText.match(/^created:.*\|(\d{4}-\d{2}-\d{2})/m)
  if (created) return created[1]
  const started = fmText.match(/^started:\s*"?(\d{4})-(\d{2})-(\d{2})/m)
  if (started) return `${started[1]}-${started[2]}-${started[3]}`
  // calendar (yyyy/mm-Month/dd-Day) and monthly (yyyy/mm-Month/dd) schemes
  const calendar = relPath.match(/(\d{4})\/(\d{2})-[A-Za-z]+\/(\d{2})(?:-[A-Za-z]+)?(?=\/|\.md)/)
  if (calendar) return `${calendar[1]}-${calendar[2]}-${calendar[3]}`
  // compact scheme (yyyy/mm-dd)
  const compact = relPath.match(/(\d{4})\/(\d{2})-(\d{2})(?=\/|\.md)/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  // flat scheme (yyyy-mm-dd)
  const flat = relPath.match(/(\d{4})-(\d{2})-(\d{2})(?=\/|\.md)/)
  if (flat) return `${flat[1]}-${flat[2]}-${flat[3]}`
  return null
}

/** A single frontmatter property change, usable both for reporting and for
 *  the property:set fallback path. */
export interface PropChange {
  key: string
  value: string
  /** Obsidian property type for property:set. */
  propType: "text" | "date" | "number"
}

/** Result of upgrading a note: the full new content (frontmatter rewritten,
 *  body byte-identical) plus the list of changes applied. */
export interface NoteUpgrade {
  content: string
  changes: PropChange[]
}

/** Compute the upgraded content for a legacy note, or null when the note is
 *  already current or cannot be modified safely (no/odd frontmatter, skill
 *  candidate without `source: skill`). The body after the closing `---` is
 *  preserved byte-for-byte. */
export function upgradeNoteContent(
  relPath: string,
  content: string,
  docType: BackfillDocType,
): NoteUpgrade | null {
  if (!content.startsWith("---\n")) return null
  const end = content.indexOf("\n---", 4)
  if (end === -1) return null
  const fmText = content.slice(4, end)
  const body = content.slice(end + 4)
  if (body !== "" && !body.startsWith("\n") && !body.startsWith("\r")) return null

  const lines = fmText.split("\n")
  const has = (key: string): boolean => lines.some((l) => l.startsWith(`${key}:`))

  if (docType === "skill" && !lines.some((l) => /^source:\s*"?skill"?\s*$/.test(l))) {
    return null
  }

  const changes: PropChange[] = []

  // Normalize model in place and add context_window derived from its suffix
  const modelIdx = lines.findIndex((l) => l.startsWith("model:"))
  if (modelIdx >= 0) {
    const m = lines[modelIdx].match(/^model:\s*("?)(.*?)"?\s*$/)
    const originalModel = m?.[2] ?? ""
    if (originalModel) {
      const normalized = normalizeModelId(originalModel)
      if (normalized !== originalModel) {
        const quote = m?.[1] === '"' ? '"' : ""
        lines[modelIdx] = `model: ${quote}${normalized}${quote}`
        changes.push({ key: "model", value: normalized, propType: "text" })
      }
      if (!has("context_window")) {
        const cap = parseModelContextWindow(originalModel)
        if (cap) {
          lines.splice(modelIdx + 1, 0, `context_window: ${cap}`)
          changes.push({ key: "context_window", value: String(cap), propType: "number" })
        }
      }
    }
  }

  // Numeric duration next to the display string
  if (!has("duration_s")) {
    const durationIdx = lines.findIndex((l) => l.startsWith("duration:"))
    if (durationIdx >= 0) {
      const display = lines[durationIdx].match(/^duration:\s*"?([^"]*)"?\s*$/)?.[1] ?? ""
      const seconds = parseDurationToSeconds(display)
      if (seconds !== null) {
        lines.splice(durationIdx + 1, 0, `duration_s: ${seconds}`)
        changes.push({ key: "duration_s", value: String(seconds), propType: "number" })
      }
    }
  }

  // Scalar date, then the type discriminator at the very top
  if (!has("date")) {
    const date = deriveDate(fmText, relPath)
    if (date) {
      lines.unshift(`date: ${date}`)
      changes.push({ key: "date", value: date, propType: "date" })
    }
  }
  if (!has("type")) {
    lines.unshift(`type: ${docType}`)
    changes.push({ key: "type", value: docType, propType: "text" })
  }

  if (changes.length === 0) return null
  return { content: `---\n${lines.join("\n")}\n---${body}`, changes }
}
