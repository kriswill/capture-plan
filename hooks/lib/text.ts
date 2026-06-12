// text.ts — Pure string/text transformation helpers

import { appendFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import type { TokenUsage } from "../transcript.ts"

/** Append a debug message to the given log file, silently ignoring write errors. */
export function debugLog(msg: string, logFile: string): void {
  try {
    appendFileSync(logFile, msg)
  } catch {
    /* ignore */
  }
}

/** Extract the first non-empty line of plan content as a clean title, stripping markdown heading markers. */
export function extractTitle(content: string): string {
  for (const rawLine of content.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^plan:\s*/i, "")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (line) return line
  }
  return "Unnamed Plan"
}

/** Convert a title to a lowercase kebab-case slug, truncated to 80 characters at word boundaries. */
export function toSlug(title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (slug.length > 80) {
    const parts = slug.split("-")
    const kept: string[] = []
    let total = 0
    for (const part of parts) {
      const extra = part.length + (kept.length ? 1 : 0)
      if (total + extra > 80) break
      kept.push(part)
      total += extra
    }
    slug = kept.join("-") || slug
  }
  return slug || "unnamed-plan"
}

/** Remove the first non-empty line (the title) from plan content, trimming leading blank lines. */
export function stripTitleLine(content: string): string {
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^plan:\s*/i, "")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim()
    if (stripped) {
      const rest = lines.slice(i + 1)
      while (rest.length > 0 && !rest[0].trim()) rest.shift()
      return rest.join("\n")
    }
  }
  return content
}

/** Tags that provide no useful signal because they apply to every entry. */
const NOISE_TAGS = new Set([
  "claude-session",
  "claude-code",
  "claude",
  "coding-session",
  "code-session",
  "ai-session",
  "session",
])

/** Remove noise tags from a comma-separated tag string. */
export function filterNoiseTags(tagsCsv: string): string {
  return tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t && !NOISE_TAGS.has(t))
    .join(",")
}

/** Format a comma-separated tag string as YAML list items (e.g. "  - tag1\n  - tag2"). */
export function formatTagsYaml(tagsCsv: string): string {
  const tags = tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length === 0) return ""
  return tags.map((t) => `  - ${t}`).join("\n")
}

/** Merge existing tags with new comma-separated tags, deduplicating while preserving order. */
export function mergeTags(existing: string[], newTagsCsv: string): string {
  const newTags = newTagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const tag of [...existing, ...newTags]) {
    const t = tag.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      merged.push(t)
    }
  }
  return filterNoiseTags(merged.join(","))
}

/** Extract the project directory name from a cwd path (e.g. "/foo/bar" -> "bar"). When a config override is provided, it takes precedence over the directory name. */
export function getProjectName(cwd?: string, configProjectName?: string): string {
  if (configProjectName) return configProjectName
  if (!cwd) return ""
  return basename(cwd)
}

/** Build a "parent/name" label from a cwd path for display in frontmatter. */
export function getProjectLabel(cwd?: string): string {
  if (!cwd) return "unknown"
  const base = basename(cwd)
  const parent = basename(dirname(cwd))
  return parent && parent !== "." ? `${parent}/${base}` : base
}

/** Truncate a session ID to its first 8 characters for use in wikilinks. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8)
}

/** Build the vault path for a session document (project-based, no .md extension, no counter prefix). */
export function sessionDocPath(
  sessionPath: string,
  sessionId: string,
  projectSlug: string,
): string {
  const firstSegment = sessionId.split("-")[0]
  return `${sessionPath}/${projectSlug || "no-project"}/${firstSegment}`
}

/** Build the session frontmatter YAML line, or empty string if sessions are disabled. */
export function formatSessionYaml(
  sessionId: string,
  sessionEnabled: boolean,
  sessionPath: string,
  sessionDocPathOverride?: string,
): string {
  if (!sessionEnabled) return ""
  const docPath = sessionDocPathOverride ?? sessionDocPath(sessionPath, sessionId, "no-project")
  return `\nsession: "[[${docPath}|${shortSessionId(sessionId)}]]"`
}

/** Strip a context-window suffix from a model identifier, normalizing both
 *  payload style ("claude-opus-4-8[1m]") and legacy frontmatter style
 *  ("claude-opus-4-8 (1M)") to the bare model id. */
export function normalizeModelId(model: string): string {
  return model.replace(/\s*[([]\s*\d+\s*[km]\s*[)\]]\s*$/i, "").trim()
}

/** Parse the context window size from a model identifier suffix (e.g. "claude-opus-4-6[1m]" -> 1000000). Returns undefined when no suffix is present. */
export function parseModelContextCap(model: string): number | undefined {
  const match = model.match(/\[(\d+)([km])\]/i)
  if (!match) return undefined
  const num = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit === "m") return num * 1_000_000
  if (unit === "k") return num * 1_000
  return undefined
}

/** Format a number with locale-aware thousands separators (e.g. 1,234). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US")
}

/** Zero-pad a counter to 3 digits for use in vault directory names. */
export function padCounter(n: number): string {
  return String(n).padStart(3, "0")
}

/** Escape pipe characters and newlines for safe use inside markdown table cells. */
export function escapeTableCell(val: string): string {
  return val.replace(/\|/g, "\\|").replace(/\n/g, "<br>")
}

const CODE_LIKE_KEYS = new Set([
  "subagent_type",
  "language",
  "output_mode",
  "type",
  "isolation",
  "model",
])

/** Determine whether a tool argument value should be rendered as inline code in the tool log. */
export function isCodeLike(key: string, val: string): boolean {
  if (CODE_LIKE_KEYS.has(key)) return true
  if (/^[~/.]/.test(val) || val.startsWith("..")) return true
  if (val.includes("*")) return true
  if (/\.\w{1,5}$/.test(val) && !val.includes(" ")) return true
  return false
}

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".sh": "sh",
  ".bash": "bash",
  ".zsh": "zsh",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".html": "html",
  ".sql": "sql",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".swift": "swift",
}

/** Map a file path's extension to a markdown code fence language identifier. */
export function langFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".")
  if (dot === -1) return ""
  return EXT_TO_LANG[filePath.slice(dot)] ?? ""
}

/** Compute context window usage as an integer percentage of the cap. */
export function computeContextPct(tokens: TokenUsage, contextCap: number): number {
  if (contextCap <= 0) return 0
  return Math.round(((tokens.input + tokens.output) / contextCap) * 100)
}

/** Format a context cap as a compact label (e.g. 200000 -> "200K", 1000000 -> "1M"). */
export function contextCapLabel(cap: number): string {
  if (cap >= 1_000_000 && cap % 1_000_000 === 0) return `${cap / 1_000_000}M`
  return `${Math.round(cap / 1_000)}K`
}

/** Return a YAML frontmatter line for the Claude Code version, or empty string if absent. */
export function formatCcVersionYaml(ccVersion?: string): string {
  if (!ccVersion) return ""
  return `\ncc_version: "${ccVersion}"`
}

/** Format model name and context cap as a compact inline label (e.g. "opus-4(200K)"). */
export function formatModelLabel(model?: string, contextCap?: number): string {
  if (!model) return ""
  if (!contextCap || contextCap <= 0) return model
  return `${model}(${contextCapLabel(contextCap)})`
}

/** Format comma-separated tags as inline hashtags (e.g. "#tag1 #tag2"). */
export function formatHashtags(tagsCsv: string): string {
  const tags = tagsCsv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length === 0) return ""
  return tags.map((t) => `#${t}`).join(" ")
}

/** Build a single journal revision bullet line for use inside a callout block. */
export function formatJournalRevision(
  time: string,
  planPath: string,
  linkText: string,
  modelLabel: string,
  summary: string,
  tags: string,
): string {
  const modelPart = modelLabel ? ` \`${modelLabel}\`` : ""
  const tagLine = formatHashtags(tags)
  const lines = [`> - **${time}** [[${planPath}|${linkText}]]${modelPart}`, `>   ${summary}`]
  if (tagLine) lines.push(`>   ${tagLine}`)
  return lines.join("\n")
}

/** Build a complete journal callout block with header, metadata, and initial revision. */
export function formatJournalCallout(
  title: string,
  project: string,
  source: string,
  revision: string,
): string {
  const metaParts: string[] = []
  if (project) metaParts.push(`\`${project}\``)
  metaParts.push(`\`${source}\``)
  const metaLine = metaParts.join(" \u00b7 ")
  return `> [!plan]+ ${title}\n> ${metaLine}\n>\n${revision}`
}

/** Escape content for the Obsidian CLI append command: newlines and wikilink pipes. */
export function escapeForObsidianAppend(content: string): string {
  // Note: Bun.spawnSync passes args directly (no shell), so real newlines work.
  // Escaping to literal \n causes Obsidian CLI to crash (exit 255) on Windows.
  // Only escape pipe chars inside wikilinks for the append command.
  return content.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, "[[$1\\|$2]]")
}

/** Ensure a path ends with `.md`, appending the extension if missing. */
export function ensureMdExt(path: string): string {
  return path.endsWith(".md") ? path : `${path}.md`
}

/** Return the weekday name (e.g. "Saturday") for a given date, defaulting to today. */
export function getDayName(date: Date = new Date()): string {
  return date.toLocaleDateString("en-US", { weekday: "long" })
}
