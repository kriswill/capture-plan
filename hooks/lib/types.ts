// types.ts — Shared type definitions and path constants

import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { TranscriptStats } from "../transcript.ts"
import type { DateScheme } from "./dates.ts"

/** Configuration for a single path section (plan or journal). */
export interface PathConfig {
  path: string
  date_scheme: DateScheme
}

/** Configuration for session document capture. */
export interface SessionConfig {
  path: string
  prompt_max_chars?: number
  enabled?: boolean
}

/** Which layer of the TOML config cascade a value originated from. */
export type ConfigLayer = "plugin" | "user" | "project"

/** A single misplaced-key warning emitted by loadConfig when a known top-level scalar key is found scoped under a nested table. */
export interface ConfigWarning {
  /** The top-level key that was found in the wrong table. */
  key: string
  /** The TOML table name where the key was found (e.g. "journal"). */
  table: string
  /** Which config layer the misplacement was detected in. */
  layer: ConfigLayer
}

/** Plugin configuration loaded from the 3-layer TOML config cascade. */
export interface Config {
  vault?: string
  project_name?: string
  plan: PathConfig
  journal: PathConfig
  skills: PathConfig
  session: SessionConfig
  context_cap?: number
  superpowers_spec_pattern?: string
  superpowers_plan_pattern?: string
  capture_skills?: string[]
  /** Misplaced-key warnings detected during TOML cascade load. Omitted when all keys are correctly placed. */
  warnings?: ConfigWarning[]
}

/** Persisted state that bridges the ExitPlanMode and Stop hooks within a session. */
export interface SessionState {
  session_id: string
  plan_slug: string
  plan_title: string
  /**
   * Vault-relative path of the plan/skill directory created for this session.
   * - For `source === "skill"`: relative to `config.skills.path`.
   * - For `source === "plan-mode"` (and default/legacy): relative to `config.plan.path`.
   */
  plan_dir: string
  date_key: string
  timestamp: string
  journal_path?: string
  project?: string
  tags?: string
  model?: string
  cc_version?: string
  planStats?: TranscriptStats
  source?: "plan-mode" | "superpowers" | "skill"
  spec_path?: string
  skill_name?: string
  completed?: boolean
}

/** Parsed YAML frontmatter fields from a plan note. */
export interface PlanFrontmatter {
  created?: string
  journalPath?: string
  datetime?: string
  status?: string
  tags?: string[]
  counter?: number
  session?: string
  project?: string
  source_slug?: string
}

/** Context window and version info read from the SessionStart hint file. */
export interface ContextHintResult {
  context_cap?: number
  cc_version?: string
}

/** Data written to a temp file at session start for downstream hooks to discover context cap, version, and session state. */
export interface ContextHint {
  session_id: string
  context_cap?: number
  model?: string
  cc_version?: string
  source: string
  session_enabled: boolean
  transcript_path?: string
  /** Cached vault path for the session document (set after creation). */
  session_doc_path?: string
  /** Vault-relative plan directory path (set by capture-plan when state is written, cleared by capture-done after consumption). */
  plan_dir?: string
}

/** A subagent prompt to be written as a separate note in the vault. */
export interface AgentFileEntry {
  path: string // Obsidian vault path (no .md extension)
  content: string // raw prompt markdown
}

/** Rendered tool-log markdown together with any extracted agent prompt files. */
export interface ToolsLogResult {
  markdown: string
  agentFiles: AgentFileEntry[]
}

/** Absolute path to the hooks/ directory (derived from the running script). */
export const HOOKS_DIR = dirname(Bun.main)
/** Absolute path to the plugin root directory. Prefers CLAUDE_PLUGIN_ROOT env var (set by CC for plugin hooks) over Bun.main derivation to avoid symlink resolution issues. */
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || dirname(HOOKS_DIR)
/** True when the plugin is running from a symlinked dev repo (has .git dir). */
export const IS_DEV_MODE: boolean = existsSync(join(PLUGIN_ROOT, ".git"))

/**
 * True when dev mode is on AND the session's cwd is inside the plugin repo.
 *
 * Used to suppress vault writes from sessions run inside the capture-plan
 * repo while in dev mode, without suppressing skill captures from any other
 * project that happens to be using the symlinked plugin.
 */
export function isDevSessionInPluginRepo(
  cwd: string | undefined,
  pluginRoot: string,
  isDevMode: boolean,
): boolean {
  if (!isDevMode || !cwd) return false
  const rel = relative(resolve(pluginRoot), resolve(cwd))
  // On Windows, when cwd and pluginRoot live on different drives, `relative`
  // returns an absolute path (e.g. "D:\..."), which is "outside" pluginRoot.
  if (isAbsolute(rel)) return false
  return rel === "" || !rel.startsWith("..")
}
