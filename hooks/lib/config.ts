// config.ts — Config loading, context hints, version detection, transcript discovery

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DATE_SCHEMES, type DateScheme } from "./dates.ts"
import { debugLog, filterNoiseTags } from "./text.ts"
import {
  type Config,
  type ConfigLayer,
  type ConfigWarning,
  type ContextHint,
  type ContextHintResult,
  PLUGIN_ROOT,
  type SessionConfig,
} from "./types.ts"

/** Claude Code session file shape at ~/.claude/sessions/{pid}.json. */
export interface CcSession {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind?: string
  entrypoint?: string
}

/** Find the active Claude Code session for a given CWD by scanning ~/.claude/sessions/. Picks the session with the highest startedAt when multiple match. */
export function findActiveSession(cwd: string, sessionsDir?: string): CcSession | null {
  sessionsDir ??= join(homedir(), ".claude", "sessions")
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return null
  }

  let best: CcSession | null = null

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    const fullPath = join(sessionsDir, entry)
    try {
      // Only consider files modified within the last 24 hours to skip ancient sessions
      const mtime = statSync(fullPath).mtimeMs
      if (Date.now() - mtime > 86_400_000) continue

      const raw = readFileSync(fullPath, "utf8")
      const parsed = JSON.parse(raw) as CcSession
      if (parsed.cwd !== cwd) continue
      if (!best || parsed.startedAt > best.startedAt) {
        best = parsed
      }
    } catch {
      /* skip unreadable/malformed files */
    }
  }

  return best
}

const PLUGIN_DEFAULT_CONFIG = join(PLUGIN_ROOT, "capture-plan.toml")

/**
 * Returns the platform-specific user config directory for capture-plan.
 * - Windows: `%LOCALAPPDATA%\capture-plan` (falls back to `~\AppData\Local\capture-plan`)
 * - macOS/Linux: `~/.config/capture-plan`
 * @param platformOverride - For testing only; if provided, uses this instead of detecting the platform
 */
export function getUserConfigDir(platformOverride?: string): string {
  const home = homedir()
  const currentPlatform = platformOverride ?? platform()
  if (currentPlatform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return join(localAppData, "capture-plan")
    return join(home, "AppData", "Local", "capture-plan")
  }
  return join(home, ".config", "capture-plan")
}

/** Returns the platform-specific user-global config file path. */
export function userGlobalConfigPath(): string {
  return join(getUserConfigDir(), "config.toml")
}

const USER_GLOBAL_CONFIG = userGlobalConfigPath()

const DEFAULT_PLAN_PATH = "Claude/Plans"
const DEFAULT_JOURNAL_PATH = "Claude/Journal"
const DEFAULT_SKILLS_PATH = "Claude/Skills"
const DEFAULT_SESSION_PATH = "Claude/Sessions"
const DEFAULT_DATE_SCHEME: DateScheme = "calendar"

/** Default session configuration. */
const DEFAULT_SESSION_CONFIG: SessionConfig = {
  path: DEFAULT_SESSION_PATH,
}

/** Default plugin configuration for reference and testing. */
export const DEFAULT_CONFIG: Config = {
  plan: { path: DEFAULT_PLAN_PATH, date_scheme: DEFAULT_DATE_SCHEME },
  journal: { path: DEFAULT_JOURNAL_PATH, date_scheme: DEFAULT_DATE_SCHEME },
  skills: { path: DEFAULT_SKILLS_PATH, date_scheme: DEFAULT_DATE_SCHEME },
  session: DEFAULT_SESSION_CONFIG,
}

const KNOWN_TOP_LEVEL_SCALAR_KEYS = [
  "vault",
  "project_name",
  "context_cap",
  "capture_skills",
  "plan_path",
  "journal_path",
  "skills_path",
  "superpowers_spec_pattern",
  "superpowers_plan_pattern",
] as const

const KNOWN_NESTED_TABLES = ["plan", "journal", "skills", "session"] as const

/**
 * For a single layer, lift any known top-level scalar key found scoped under a known nested table
 * back to the layer's top level. Only lifts when the top-level slot is undefined for that layer.
 * Returns a cloned layer (original is not mutated) and a list of warnings describing each lift.
 */
export function recoverStrayKeysFromLayer(
  layer: Record<string, unknown> | null,
  layerName: ConfigLayer,
): { recovered: Record<string, unknown> | null; warnings: ConfigWarning[] } {
  if (layer === null) return { recovered: null, warnings: [] }

  const recovered: Record<string, unknown> = { ...layer }
  const warnings: ConfigWarning[] = []

  for (const tableName of KNOWN_NESTED_TABLES) {
    const tableVal = recovered[tableName]
    if (typeof tableVal !== "object" || tableVal === null || Array.isArray(tableVal)) {
      continue
    }
    const nestedTable = tableVal as Record<string, unknown>

    for (const key of KNOWN_TOP_LEVEL_SCALAR_KEYS) {
      if (nestedTable[key] !== undefined && recovered[key] === undefined) {
        recovered[key] = nestedTable[key]
        const clonedTable = { ...nestedTable }
        delete clonedTable[key]
        recovered[tableName] = clonedTable
        warnings.push({ key, table: tableName, layer: layerName })
      }
    }
  }

  return { recovered, warnings }
}

/** Load and parse a TOML file, returning null if the file is missing or unparseable. */
export async function loadToml(path: string): Promise<Record<string, unknown> | null> {
  try {
    const loaded = await import(path)
    return loaded.default ?? loaded
  } catch {
    // Fallback: import() can fail through symlinks in dev mode.
    // Read the file directly and parse with Bun's built-in TOML parser.
    try {
      const raw = readFileSync(path, "utf8")
      return Bun.TOML.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

/** Validate and return a DateScheme, falling back to the default if invalid. */
function resolveScheme(raw: unknown): DateScheme {
  if (typeof raw === "string" && (DATE_SCHEMES as readonly string[]).includes(raw)) {
    return raw as DateScheme
  }
  return DEFAULT_DATE_SCHEME
}

/** Load plugin configuration by merging the 3-layer TOML cascade (plugin default, user global, project local). */
export async function loadConfig(cwd?: string): Promise<Config> {
  const pluginDefault = await loadToml(PLUGIN_DEFAULT_CONFIG)
  const userGlobal = await loadToml(USER_GLOBAL_CONFIG)
  const projectPath = cwd ? join(cwd, ".claude", "capture-plan.toml") : null
  const project = projectPath ? await loadToml(projectPath) : null

  const pluginR = recoverStrayKeysFromLayer(pluginDefault, "plugin")
  const userR = recoverStrayKeysFromLayer(userGlobal, "user")
  const projectR = recoverStrayKeysFromLayer(project, "project")
  const warnings: ConfigWarning[] = [...pluginR.warnings, ...userR.warnings, ...projectR.warnings]
  const merged = { ...pluginR.recovered, ...userR.recovered, ...projectR.recovered }

  const rawProjectName = merged.project_name
  const projectName =
    typeof rawProjectName === "string" && rawProjectName.trim() ? rawProjectName.trim() : undefined

  const rawCap = merged.context_cap
  const contextCap = typeof rawCap === "number" && rawCap > 0 ? rawCap : undefined
  const rawCaptureSkills = merged.capture_skills
  const captureSkills = Array.isArray(rawCaptureSkills)
    ? rawCaptureSkills.filter((s): s is string => typeof s === "string")
    : undefined

  // Resolve plan config: grouped [plan] table takes precedence over flat plan_path key
  const mergedPlan = merged.plan as Record<string, unknown> | undefined
  const planPath = (mergedPlan?.path as string) || (merged.plan_path as string) || DEFAULT_PLAN_PATH
  const planScheme = resolveScheme(mergedPlan?.date_scheme)

  // Resolve skills config: grouped [skills] table takes precedence; date_scheme inherits from plan when omitted
  const mergedSkills = merged.skills as Record<string, unknown> | undefined
  const skillsPath =
    (mergedSkills?.path as string) || (merged.skills_path as string) || DEFAULT_SKILLS_PATH
  const skillsScheme = mergedSkills?.date_scheme
    ? resolveScheme(mergedSkills.date_scheme as string)
    : planScheme

  // Resolve journal config: grouped [journal] table takes precedence over flat journal_path key
  const mergedJournal = merged.journal as Record<string, unknown> | undefined
  const journalPath =
    (mergedJournal?.path as string) || (merged.journal_path as string) || DEFAULT_JOURNAL_PATH
  const journalScheme = resolveScheme(mergedJournal?.date_scheme)

  // Resolve session config: deep-merge [session] tables across cascade layers
  // so a project-local `[session] path = "..."` doesn't clobber a global `enabled = true`
  const deepSession = {
    ...(pluginDefault?.session as Record<string, unknown> | undefined),
    ...(userGlobal?.session as Record<string, unknown> | undefined),
    ...(project?.session as Record<string, unknown> | undefined),
  }
  const sessionPath = (deepSession.path as string) || DEFAULT_SESSION_PATH
  const rawPromptMax = deepSession.prompt_max_chars
  const promptMaxChars =
    typeof rawPromptMax === "number" && rawPromptMax > 0 ? rawPromptMax : undefined
  const sessionEnabled = deepSession.enabled === true
  const session: SessionConfig = {
    path: sessionPath,
    prompt_max_chars: promptMaxChars,
    enabled: sessionEnabled,
  }

  return {
    vault: (merged.vault as string) || undefined,
    project_name: projectName,
    plan: { path: planPath, date_scheme: planScheme },
    journal: { path: journalPath, date_scheme: journalScheme },
    skills: { path: skillsPath, date_scheme: skillsScheme },
    session,
    context_cap: contextCap,
    superpowers_spec_pattern: (merged.superpowers_spec_pattern as string) || undefined,
    superpowers_plan_pattern: (merged.superpowers_plan_pattern as string) || undefined,
    capture_skills: captureSkills,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

const SUMMARIZE_TIMEOUT_MS = 30_000

/** Summarize content using Claude Haiku, returning a short summary and comma-separated tags. Falls back to text extraction on failure or timeout. */
export async function summarizeWithClaude(
  content: string,
  systemPrompt: string,
): Promise<{ summary: string; tags: string }> {
  if (process.env.CAPTURE_PLAN_MOCK_SUMMARIZE) {
    const stub = content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    return { summary: stub || "Mock summary", tags: "e2e-test" }
  }

  let summary = ""
  let tags = ""

  try {
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        "--bare",
        "--max-turns",
        "1",
        "--model",
        "claude-haiku-4-5-20251001",
        "--output-format",
        "text",
        "--system-prompt",
        systemPrompt,
        "Summarise and tag this content:",
      ],
      { stdin: new Blob([content]), stdout: "pipe", stderr: "pipe" },
    )
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill()
        reject(new Error("summarize timed out"))
      }, SUMMARIZE_TIMEOUT_MS)
    })
    const result = await Promise.race([
      (async () => {
        const output = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        return { output, exitCode }
      })(),
      timeout,
    ])
    if (result.exitCode === 0 && !result.output.toLowerCase().includes("not logged in")) {
      const lines = result.output.trim().split("\n").filter(Boolean)
      if (lines.length >= 1) summary = lines[0].trim()
      if (lines.length >= 2) tags = filterNoiseTags(lines[lines.length - 1].trim())
    }
  } catch {
    /* fallback below */
  }

  if (!summary) {
    summary = content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^(?:#+\s*|\|.*\|$|\s*[-*]\s+)/gm, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
    if (!summary) summary = "Captured from Claude Code session."
  }
  if (!tags) tags = ""
  summary = summary.replace(/\n/g, " ").trim()
  return { summary, tags }
}

const DEFAULT_CONTEXT_CAP = 200_000

/** Build the path to the context hint file for a session. */
export function contextHintPath(sessionId: string): string {
  return join(tmpdir(), `capture-plan-context-${sessionId}.json`)
}

/** Read the full context hint written by SessionStart. Returns null if missing or unreadable. */
export function readContextHintFull(sessionId: string): ContextHint | null {
  try {
    const raw = readFileSync(contextHintPath(sessionId), "utf8")
    return JSON.parse(raw) as ContextHint
  } catch {
    return null
  }
}

/** Read the context hint file written by SessionStart, returning context cap and CC version. */
export function readContextHint(sessionId: string): ContextHintResult {
  const hint = readContextHintFull(sessionId)
  if (!hint) return {}
  return {
    context_cap:
      typeof hint.context_cap === "number" && hint.context_cap > 0 ? hint.context_cap : undefined,
    cc_version: typeof hint.cc_version === "string" ? hint.cc_version : undefined,
  }
}

/** Read the Claude Code version string from the session's context hint file. */
export function readCcVersion(sessionId: string): string | undefined {
  return readContextHint(sessionId).cc_version
}

/** Read the cached session document vault path from the context hint file. */
export function readSessionDocPath(sessionId: string): string | undefined {
  const hint = readContextHintFull(sessionId)
  return typeof hint?.session_doc_path === "string" ? hint.session_doc_path : undefined
}

const CONFIG_DEBUG_LOG = join(tmpdir(), "capture-config-debug.log")

/**
 * Merge partial updates into the context hint file. Only overwrites supplied keys;
 * other fields are preserved. When the hint file is missing (SessionStart ran
 * without a stdin payload and no lazy bootstrap has fired yet), the patch is
 * silently dropped — a debug line is logged so the failure mode is observable.
 */
export function updateContextHint(
  sessionId: string,
  patch: Partial<Pick<ContextHint, "plan_dir" | "session_doc_path">>,
): void {
  const hint = readContextHintFull(sessionId)
  if (!hint) {
    debugLog(
      `updateContextHint: no hint file for session ${sessionId}; patch ${JSON.stringify(patch)} dropped\n`,
      CONFIG_DEBUG_LOG,
    )
    return
  }
  writeFileSync(contextHintPath(sessionId), JSON.stringify({ ...hint, ...patch }))
}

/** Parse Claude Code version from `claude --version` output (e.g. "2.1.89 (Claude Code)"). */
export function parseCcVersion(raw: string): string | undefined {
  const match = raw.trim().match(/^(\d+\.\d+\.\d+)/)
  return match ? `v${match[1]}` : undefined
}

/** Detect the installed Claude Code version by running `claude --version`. */
export function detectCcVersion(): string | undefined {
  try {
    const result = Bun.spawnSync(["claude", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) return undefined
    return parseCcVersion(result.stdout.toString())
  } catch {
    return undefined
  }
}

/** Resolve the context window cap from config, session hint, or peak usage heuristic. */
export function resolveContextCap(
  peakContext: number,
  configCap?: number,
  sessionId?: string,
): number {
  if (configCap && configCap > 0) return configCap
  if (sessionId) {
    const hint = readContextHint(sessionId)
    if (hint.context_cap) return hint.context_cap
  }
  if (peakContext > DEFAULT_CONTEXT_CAP) return 1_000_000
  return DEFAULT_CONTEXT_CAP
}

/** Locate the JSONL transcript file for a session using the cwd-derived project slug. */
export function findTranscriptPath(sessionId: string, cwd?: string): string | null {
  if (!cwd) return null
  const projectsDir = join(homedir(), ".claude", "projects")
  // Replace both / and \ with -, then remove any remaining : (Windows drive letter)
  const slug = `-${cwd.replace(/[/\\]/g, "-").replace(/:/g, "")}`
  const p = join(projectsDir, slug, `${sessionId}.jsonl`)
  try {
    if (Bun.file(p).size > 0) return p
  } catch {
    /* */
  }
  return null
}
