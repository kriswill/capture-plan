// types.ts — Shared type definitions and path constants

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
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

/** Configuration for plugin-managed Obsidian Bases (.base database views). */
export interface BasesConfig {
  /** When true (default), the plugin creates and authoritatively maintains its .base files. */
  enabled: boolean
  /** Vault-relative folder where managed .base files live. */
  path: string
}

/** Plugin configuration loaded from the 3-layer TOML config cascade. */
export interface Config {
  vault?: string
  project_name?: string
  plan: PathConfig
  journal: PathConfig
  session: SessionConfig
  bases: BasesConfig
  context_cap?: number
  superpowers_spec_pattern?: string
  superpowers_plan_pattern?: string
  capture_skills?: string[]
}

/** Persisted state that bridges the ExitPlanMode and Stop hooks within a session. */
export interface SessionState {
  session_id: string
  plan_slug: string
  plan_title: string
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
  /** BASES_VERSION that was last synced to the vault this session (skips redundant re-sync). */
  bases_synced?: number
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
