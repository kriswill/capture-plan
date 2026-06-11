// session-doc.ts — Session document creation and upsert logic

import { readdirSync } from "node:fs"
import { join } from "node:path"
import { updateContextHint } from "./config.ts"
import {
  createVaultNote,
  getVaultPath,
  readVaultNote,
  removeVaultProperty,
  runObsidian,
  setVaultProperty,
} from "./obsidian.ts"
import { formatEventLine, type SessionEvent } from "./session-events.ts"
import {
  ensureMdExt,
  normalizeModelId,
  padCounter,
  parseModelContextCap,
  shortSessionId,
  toSlug,
} from "./text.ts"
import type { SessionConfig } from "./types.ts"

const COUNTER_PREFIX_RE = /^(\d{3,})-/

/** Display name for sessions with no known project. */
const FALLBACK_PROJECT = "_no project_"

/** Slug used in vault paths for sessions with no known project. */
export const FALLBACK_PROJECT_SLUG = "no-project"

/** A wikilink entry parsed from or destined for session document frontmatter. */
interface SessionLink {
  path: string
  title: string
}

/** Find an existing session doc in the project directory, or build a new counter-prefixed path. Single directory scan handles both lookup and counter computation. */
function resolveSessionDocPath(
  sessionPath: string,
  sessionId: string,
  projectSlug: string,
  vault?: string,
): string {
  const firstSegment = sessionId.split("-")[0]
  const vaultPath = getVaultPath(vault)
  if (vaultPath) {
    const projectDir = join(vaultPath, sessionPath, projectSlug)
    let entries: string[]
    try {
      entries = readdirSync(projectDir)
    } catch {
      entries = []
    }
    let max = 0
    for (const entry of entries) {
      const name = entry.replace(/\.md$/, "")
      if (COUNTER_PREFIX_RE.test(name) && name.endsWith(firstSegment)) {
        return `${sessionPath}/${projectSlug}/${name}`
      }
      const m = name.match(COUNTER_PREFIX_RE)
      if (m) {
        const num = parseInt(m[1], 10)
        if (num > max) max = num
      }
    }
    return `${sessionPath}/${projectSlug}/${padCounter(max + 1)}-${firstSegment}`
  }
  return `${sessionPath}/${projectSlug}/001-${firstSegment}`
}

/** Options for initially creating a session document in the vault. */
export interface CreateSessionDocOpts {
  sessionId: string
  session: SessionConfig
  vault?: string
  project?: string
  started: string
  model?: string
  ccVersion?: string
}

/** Options for creating or updating a session document in the vault. */
export interface UpsertSessionDocOpts {
  sessionId: string
  session: SessionConfig
  vault?: string
  project?: string
  /** Cached session doc path from the context hint file. Falls back to project-based lookup if absent. */
  sessionDocPath?: string
  plans?: SessionLink[]
  summaries?: SessionLink[]
  toolsStats?: SessionLink[]
  toolsLogs?: SessionLink[]
  activities?: SessionLink[]
  mode?: "normal" | "plan"
  events?: SessionEvent[]
}

/** Metadata fields shared by all session-doc frontmatter builders. */
interface SessionFmFields {
  sessionId: string
  project?: string
  started?: string
  model?: string
  contextWindow?: number
  ccVersion?: string
  mode: string
}

/** Format the session-doc frontmatter header lines (type, id, project, started/date, normalized model + context_window, cc_version, mode). */
function formatSessionFmLines(f: SessionFmFields): string[] {
  const lines: string[] = []
  lines.push("type: session")
  lines.push(`session_id: "${f.sessionId}"`)
  if (f.project) lines.push(`project: "${f.project}"`)
  if (f.started) {
    lines.push(`started: "${f.started}"`)
    lines.push(`date: ${f.started.slice(0, 10)}`)
  }
  if (f.model) {
    lines.push(`model: "${normalizeModelId(f.model)}"`)
    const cap = f.contextWindow ?? parseModelContextCap(f.model)
    if (cap) lines.push(`context_window: ${cap}`)
  }
  if (f.ccVersion) lines.push(`cc_version: "${f.ccVersion}"`)
  lines.push(`mode: ${f.mode}`)
  return lines
}

/** Parse a YAML list of wikilinks from session document frontmatter. */
function parseWikilinks(fm: string, key: string): SessionLink[] {
  const section = fm.match(new RegExp(`^${key}:\\n((?:\\s+-\\s+.+\\n?)*)`, "m"))
  if (!section) return []
  const links: SessionLink[] = []
  for (const line of section[1].split("\n")) {
    const match = line.match(/\[\[([^|]+)\|([^\]]+)\]\]/)
    if (match) links.push({ path: match[1], title: match[2] })
  }
  return links
}

/** Merge new links into existing ones, deduplicating by path. */
function mergeLinks(existing: SessionLink[], incoming: SessionLink[]): SessionLink[] {
  const seen = new Set(existing.map((l) => l.path))
  const result = [...existing]
  for (const link of incoming) {
    if (!seen.has(link.path)) {
      result.push(link)
      seen.add(link.path)
    }
  }
  return result
}

/** Format a list of wikilinks as YAML frontmatter lines. */
function formatLinksYaml(key: string, links: SessionLink[]): string {
  if (links.length === 0) return ""
  const items = links.map((l) => `  - "[[${l.path}|${l.title.replace(/"/g, "'")}]]"`)
  return `${key}:\n${items.join("\n")}`
}

/** Extract the body content after the frontmatter closing `---`. */
function parseBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return match ? match[1] : ""
}

/** Extract existing event entries from the `## Events` section of the body. Each entry may span multiple lines (e.g. prompt code fences, stop message markdown). A new entry starts with `### ` (or legacy `- ` for backwards compatibility); all lines between entries are grouped with the preceding entry. */
function parseEventLines(body: string): string[] {
  const eventsMatch = body.match(/## Events\n\n([\s\S]*)$/)
  if (!eventsMatch) return []

  const entries: string[] = []
  for (const line of eventsMatch[1].split("\n")) {
    if (line.startsWith("### ") || line.startsWith("- ")) {
      entries.push(line)
    } else if (entries.length > 0) {
      // Continuation line (including blank lines) — append to current entry
      entries[entries.length - 1] += `\n${line}`
    }
  }
  return entries.map((e) => e.trimEnd())
}

/** Create a new session document in the vault. Returns the doc path on success, null on failure or if already exists. Caller must check session.enabled before calling. */
export function createSessionDoc(opts: CreateSessionDocOpts): string | null {
  const projectSlug = toSlug(opts.project || FALLBACK_PROJECT)
  const docPath = resolveSessionDocPath(opts.session.path, opts.sessionId, projectSlug, opts.vault)

  // Don't overwrite an existing doc (e.g. on session restart)
  const existing = readVaultNote(docPath, opts.vault)
  if (existing) return null

  const fmLines = formatSessionFmLines({
    sessionId: opts.sessionId,
    project: opts.project,
    started: opts.started,
    model: opts.model,
    ccVersion: opts.ccVersion,
    mode: "normal",
  })

  const startEvent: SessionEvent = {
    ts: opts.started,
    type: "start",
  }

  const content = `---\n${fmLines.join("\n")}\n---\n# Session Log\n\n## Events\n\n${formatEventLine(startEvent)}\n`

  const result = createVaultNote(docPath, content, opts.vault)
  return result.success ? docPath : null
}

/** Create or update a session document in the vault, accumulating back-links to plans, summaries, and tool notes. Caller must check session.enabled before calling. */
export function upsertSessionDoc(opts: UpsertSessionDocOpts): boolean {
  const projectSlug = toSlug(opts.project || FALLBACK_PROJECT)
  const docPath =
    opts.sessionDocPath ??
    resolveSessionDocPath(opts.session.path, opts.sessionId, projectSlug, opts.vault)

  // Read existing document to merge links and events
  const existingContent = readVaultNote(docPath, opts.vault)
  const ex = existingContent ? parseSessionDoc(existingContent) : null

  // Merge incoming links with existing
  const plans = mergeLinks(ex?.plans ?? [], opts.plans ?? [])
  const summaries = mergeLinks(ex?.summaries ?? [], opts.summaries ?? [])
  const toolsStats = mergeLinks(ex?.toolsStats ?? [], opts.toolsStats ?? [])
  const toolsLogs = mergeLinks(ex?.toolsLogs ?? [], opts.toolsLogs ?? [])
  const activities = mergeLinks(ex?.activities ?? [], opts.activities ?? [])

  const project = opts.project ?? ex?.project
  const mode = opts.mode ?? ex?.mode ?? "normal"

  // Build frontmatter
  const fmLines = formatSessionFmLines({
    sessionId: opts.sessionId,
    project,
    started: ex?.started,
    model: ex?.model,
    contextWindow: ex?.contextWindow,
    ccVersion: ex?.ccVersion,
    mode,
  })

  const linkSections = [
    formatLinksYaml("plans", plans),
    formatLinksYaml("summaries", summaries),
    formatLinksYaml("tools_stats", toolsStats),
    formatLinksYaml("tools_logs", toolsLogs),
    formatLinksYaml("activities", activities),
  ].filter(Boolean)

  if (linkSections.length > 0) {
    fmLines.push(linkSections.join("\n"))
  }

  // Merge events: existing lines + new events formatted as lines
  const newEventLines = (opts.events ?? []).map(formatEventLine)
  const allEventLines = [...(ex?.eventLines ?? []), ...newEventLines]

  const eventsSection = allEventLines.length > 0 ? `${allEventLines.join("\n\n")}\n` : ""
  const content = `---\n${fmLines.join("\n")}\n---\n# Session Log\n\n## Events\n\n${eventsSection}`

  return createVaultNote(docPath, content, opts.vault).success
}

/** Options for relocating a session document to a different project folder. */
export interface RelocateSessionDocOpts {
  oldDocPath: string
  newProject: string
  session: SessionConfig
  vault?: string
}

/** Parse frontmatter metadata fields from raw frontmatter text. */
function parseFrontmatterMeta(fm: string): {
  project?: string
  started?: string
  model?: string
  contextWindow?: number
  ccVersion?: string
  mode?: string
} {
  const get = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"))
    return m ? m[1].trim() : undefined
  }
  const rawContextWindow = get("context_window")
  const contextWindow = rawContextWindow ? parseInt(rawContextWindow, 10) : Number.NaN
  return {
    project: get("project"),
    started: get("started"),
    model: get("model"),
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    ccVersion: get("cc_version"),
    mode: get("mode"),
  }
}

/** Parse all structured data from a session document. */
function parseSessionDoc(content: string) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  const fm = fmMatch ? fmMatch[1] : ""
  const meta = parseFrontmatterMeta(fm)
  const body = parseBody(content)
  return {
    ...meta,
    plans: parseWikilinks(fm, "plans"),
    summaries: parseWikilinks(fm, "summaries"),
    toolsStats: parseWikilinks(fm, "tools_stats"),
    toolsLogs: parseWikilinks(fm, "tools_logs"),
    activities: parseWikilinks(fm, "activities"),
    eventLines: parseEventLines(body),
  }
}

/** Deduplicate event lines, preserving order. */
function dedupeEventLines(lines: string[]): string[] {
  const seen = new Set<string>()
  return lines.filter((line) => {
    if (seen.has(line)) return false
    seen.add(line)
    return true
  })
}

/** Move a session document from one project folder to another, merging with any existing doc at the target. Returns the new doc path on success, null on failure. */
export function relocateSessionDoc(opts: RelocateSessionDocOpts): string | null {
  const oldContent = readVaultNote(opts.oldDocPath, opts.vault)
  if (!oldContent) return null

  const idMatch = oldContent.match(/^session_id:\s*"?([^"\n]+)"?/m)
  if (!idMatch) return null
  const sessionId = idMatch[1].trim()

  const newProjectSlug = toSlug(opts.newProject)
  const newDocPath = resolveSessionDocPath(opts.session.path, sessionId, newProjectSlug, opts.vault)

  // Parse old doc
  const old = parseSessionDoc(oldContent)

  // Check if a doc already exists at the target (created by another hook that knew the project)
  const targetContent = readVaultNote(newDocPath, opts.vault)
  const target = targetContent ? parseSessionDoc(targetContent) : null

  // Merge: prefer target metadata when present (it was created with correct project context)
  const started = target?.started ?? old.started
  const model = target?.model ?? old.model
  const ccVersion = target?.ccVersion ?? old.ccVersion
  const mode = target?.mode ?? old.mode ?? "normal"
  const plans = mergeLinks(target?.plans ?? [], old.plans)
  const summaries = mergeLinks(target?.summaries ?? [], old.summaries)
  const toolsStats = mergeLinks(target?.toolsStats ?? [], old.toolsStats)
  const toolsLogs = mergeLinks(target?.toolsLogs ?? [], old.toolsLogs)
  const activities = mergeLinks(target?.activities ?? [], old.activities)
  const eventLines = dedupeEventLines([...(target?.eventLines ?? []), ...old.eventLines])

  // Build merged content
  const fmLines = formatSessionFmLines({
    sessionId,
    project: opts.newProject,
    started,
    model,
    contextWindow: target?.contextWindow ?? old.contextWindow,
    ccVersion,
    mode,
  })

  const linkSections = [
    formatLinksYaml("plans", plans),
    formatLinksYaml("summaries", summaries),
    formatLinksYaml("tools_stats", toolsStats),
    formatLinksYaml("tools_logs", toolsLogs),
    formatLinksYaml("activities", activities),
  ].filter(Boolean)

  if (linkSections.length > 0) {
    fmLines.push(linkSections.join("\n"))
  }

  const eventsSection = eventLines.length > 0 ? `${eventLines.join("\n\n")}\n` : ""
  const content = `---\n${fmLines.join("\n")}\n---\n# Session Log\n\n## Events\n\n${eventsSection}`

  const result = createVaultNote(newDocPath, content, opts.vault)
  if (!result.success) return null

  // Update session: property in all documents that reference this session
  const allLinks = [...plans, ...summaries, ...toolsStats, ...toolsLogs, ...activities]
  if (allLinks.length > 0) {
    updateSessionBacklinks(newDocPath, sessionId, allLinks, opts.vault)
  }

  // Delete the old doc
  runObsidian(["delete", `path=${ensureMdExt(opts.oldDocPath)}`, "permanent"], opts.vault)

  return newDocPath
}

/** Update the `session:` frontmatter property on all documents that a session doc links to. */
function updateSessionBacklinks(
  newDocPath: string,
  sessionId: string,
  allLinks: SessionLink[],
  vault?: string,
): void {
  const sessionWikilink = `[[${newDocPath}|${shortSessionId(sessionId)}]]`
  for (const link of allLinks) {
    setVaultProperty(link.path, "session", sessionWikilink, "text", vault)
  }
}

/** Remove the `session:` frontmatter property from all documents that a session doc links to. */
export function removeSessionBacklinks(allLinks: SessionLink[], vault?: string): void {
  for (const link of allLinks) {
    removeVaultProperty(link.path, "session", vault)
  }
}

/** Options for ensuring a session document is relocated to the correct project folder. */
export interface EnsureSessionRelocatedOpts {
  sessionId: string
  cachedDocPath: string | undefined
  project: string | undefined
  session: SessionConfig
  sessionEnabled: boolean
  vault?: string
}

/** Check if a cached session doc is under no-project and relocate if project is now known. When cachedDocPath is missing, discovers the session doc in the vault. Returns the (possibly updated) doc path. Updates the hint file on success. */
export function ensureSessionRelocated(opts: EnsureSessionRelocatedOpts): string | undefined {
  const { cachedDocPath, project, sessionId } = opts

  // When no cached path, discover the session doc in the vault
  if (!cachedDocPath) {
    if (!project) {
      // No project and no cached path — pre-compute a path if sessions are enabled
      if (!opts.sessionEnabled) return undefined
      const path = resolveSessionDocPath(
        opts.session.path,
        sessionId,
        FALLBACK_PROJECT_SLUG,
        opts.vault,
      )
      updateHintPath(sessionId, path)
      return path
    }
    const projectSlug = toSlug(project)
    const discovered = findSessionDoc(opts.session.path, sessionId, projectSlug, opts.vault)
    if (discovered) {
      updateHintPath(sessionId, discovered)
      return discovered
    }
    // Also check no-project in case it was created there
    const noProjectDoc = findSessionDoc(
      opts.session.path,
      sessionId,
      FALLBACK_PROJECT_SLUG,
      opts.vault,
    )
    if (noProjectDoc) {
      // Found under no-project — relocate it
      const newPath = relocateSessionDoc({
        oldDocPath: noProjectDoc,
        newProject: project,
        session: opts.session,
        vault: opts.vault,
      })
      const resolved = newPath ?? noProjectDoc
      updateHintPath(sessionId, resolved)
      return resolved
    }
    // No existing doc found — pre-compute a path if sessions are enabled
    if (!opts.sessionEnabled) return undefined
    const path = resolveSessionDocPath(opts.session.path, sessionId, projectSlug, opts.vault)
    updateHintPath(sessionId, path)
    return path
  }

  if (!cachedDocPath.includes(`/${FALLBACK_PROJECT_SLUG}/`)) return cachedDocPath
  if (!project) return cachedDocPath

  const newPath = relocateSessionDoc({
    oldDocPath: cachedDocPath,
    newProject: project,
    session: opts.session,
    vault: opts.vault,
  })
  if (!newPath) return cachedDocPath

  updateHintPath(sessionId, newPath)
  return newPath
}

/** Update the session_doc_path in the hint file. */
function updateHintPath(sessionId: string, docPath: string): void {
  updateContextHint(sessionId, { session_doc_path: docPath })
}

/** Find an existing session doc by scanning a project directory. Returns the vault-relative path if found, null otherwise. */
function findSessionDoc(
  sessionPath: string,
  sessionId: string,
  projectSlug: string,
  vault?: string,
): string | null {
  const firstSegment = sessionId.split("-")[0]
  const vaultPath = getVaultPath(vault)
  if (!vaultPath) return null
  const projectDir = join(vaultPath, sessionPath, projectSlug)
  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const name = entry.replace(/\.md$/, "")
    if (COUNTER_PREFIX_RE.test(name) && name.endsWith(firstSegment)) {
      return `${sessionPath}/${projectSlug}/${name}`
    }
  }
  return null
}
