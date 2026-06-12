// obsidian.ts — Obsidian CLI & vault operations

import { join } from "node:path"
import { type DateParts, formatDatePath, getDatePartsFor } from "./dates.ts"
import { PLAN_DIR_PATTERN } from "./path-style.ts"
import { appendRevisionToCallout } from "./session-state.ts"
import { ensureMdExt, escapeForObsidianAppend, formatJournalCallout, mergeTags } from "./text.ts"
import type { Config } from "./types.ts"

/** Execute the Obsidian CLI with the given arguments, optionally scoped to a vault. */
export function runObsidian(
  args: string[],
  vault?: string,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const cmd = vault ? ["obsidian", `vault=${vault}`, ...args] : ["obsidian", ...args]
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr.toString().trim()
    // Obsidian CLI returns exitCode 0 even on errors — detect via stdout
    const exitCode = result.exitCode !== 0 || stdout.startsWith("Error:") ? 1 : 0
    return { stdout, stderr, exitCode }
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 }
  }
}

/** Create or replace a note in the vault via the Obsidian CLI.
 *  Uses the `overwrite` flag to atomically replace existing files without
 *  triggering Obsidian's auto-link-update (which corrupts wikilinks). */
export function createVaultNote(
  path: string,
  content: string,
  vault?: string,
): { success: boolean; exitCode: number; stdout: string; stderr: string } {
  // Note: Bun.spawnSync passes args directly (no shell), so real newlines work.
  // Escaping to literal \n causes Obsidian CLI to crash (exit 255) on Windows.
  const result = runObsidian(
    ["create", `path=${path}`, `content=${content}`, "overwrite", "silent"],
    vault,
  )
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** Resolve the absolute filesystem path of an Obsidian vault via the CLI. */
export function getVaultPath(vault?: string): string | null {
  try {
    const args = vault
      ? ["obsidian", `vault=${vault}`, "vault", "info=path"]
      : ["obsidian", "vault", "info=path"]
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
    const path = result.stdout.toString().trim()
    return path && result.exitCode === 0 ? path : null
  } catch {
    return null
  }
}

/** List immediate child folder names under a vault folder. */
export function listVaultFolders(folderRel: string, vault?: string): string[] {
  const result = runObsidian(["folders", `folder=${folderRel}`], vault)
  if (result.exitCode !== 0) return []
  const prefix = `${folderRel}/`
  const depth = folderRel.split("/").length + 1
  return result.stdout
    .split("\n")
    .filter((line) => {
      if (!line?.startsWith(prefix)) return false
      return line.split("/").length === depth
    })
    .map((line) => line.slice(prefix.length))
}

/** Return the next plan counter for a vault-relative date directory by
 *  scanning existing `NNN-slug` subfolders via the Obsidian CLI.
 *  Returns 1 when the folder doesn't exist or contains no numbered entries. */
export function nextCounter(dateDirRel: string, vault?: string): number {
  const entries = listVaultFolders(dateDirRel, vault)
  let max = 0
  for (const entry of entries) {
    const match = entry.match(PLAN_DIR_PATTERN)
    if (match) {
      const num = parseInt(match[1], 10)
      if (num > max) max = num
    }
  }
  return max + 1
}

/** List immediate child file names under a vault folder (non-recursive). */
export function listVaultFiles(folderRel: string, vault?: string): string[] {
  const result = runObsidian(["files", `folder=${folderRel}`], vault)
  if (result.exitCode !== 0) return []
  const prefix = `${folderRel}/`
  return result.stdout
    .split("\n")
    .filter((line) => {
      if (!line?.startsWith(prefix)) return false
      const rest = line.slice(prefix.length)
      return !rest.includes("/")
    })
    .map((line) => line.slice(prefix.length))
}

/** Check if a folder exists in the vault. */
export function vaultFolderExists(folderRel: string, vault?: string): boolean {
  const result = runObsidian(["folder", `path=${folderRel}`], vault)
  return result.exitCode === 0
}

/** Check if a file exists in the vault. */
export function vaultFileExists(pathRel: string, vault?: string): boolean {
  const result = runObsidian(["file", `path=${pathRel}`], vault)
  return result.exitCode === 0
}

/** Read the full content of a vault note via the Obsidian CLI. Returns null if the file doesn't exist or the CLI fails. */
export function readVaultNote(pathRel: string, vault?: string): string | null {
  const pathWithExt = ensureMdExt(pathRel)
  const result = runObsidian(["read", `path=${pathWithExt}`], vault)
  if (result.exitCode !== 0) return null
  return result.stdout || null
}

/** Read a single frontmatter property from a vault note. Returns null on failure or if the property doesn't exist. */
export function readVaultProperty(pathRel: string, name: string, vault?: string): string | null {
  const pathWithExt = ensureMdExt(pathRel)
  const result = runObsidian(["property:read", `name=${name}`, `path=${pathWithExt}`], vault)
  if (result.exitCode !== 0) return null
  return result.stdout || null
}

/** Set a single frontmatter property on a vault note via the Obsidian CLI. Returns true on success. */
export function setVaultProperty(
  pathRel: string,
  name: string,
  value: string,
  type: string,
  vault?: string,
): boolean {
  const pathWithExt = ensureMdExt(pathRel)
  const result = runObsidian(
    ["property:set", `name=${name}`, `value=${value}`, `type=${type}`, `path=${pathWithExt}`],
    vault,
  )
  return result.exitCode === 0
}

/** Remove a frontmatter property from a vault note via the Obsidian CLI. Returns true on success. */
export function removeVaultProperty(pathRel: string, name: string, vault?: string): boolean {
  const pathWithExt = ensureMdExt(pathRel)
  const result = runObsidian(["property:remove", `name=${name}`, `path=${pathWithExt}`], vault)
  return result.exitCode === 0
}

/** Ensure a vault directory exists by creating and deleting a placeholder file.
 *  The Obsidian CLI `create` command creates parent directories automatically. */
export function ensureVaultDir(dirRel: string, vault?: string): void {
  const placeholder = `${dirRel}/placeholder.md`
  runObsidian(["create", `path=${placeholder}`, "content=placeholder", "silent"], vault)
  runObsidian(["delete", `path=${placeholder}`, "permanent"], vault)
}

/** Read existing tags from a daily note and merge in new ones, deduplicating. */
export function mergeTagsOnDailyNote(newTags: string, journalPath: string, vault?: string): void {
  if (!journalPath) return
  const existingRaw = readVaultProperty(journalPath, "tags", vault)
  const existingTags = existingRaw ? existingRaw.split("\n").filter((l) => l.trim()) : []
  const mergedTags = mergeTags(existingTags, newTags)
  if (!mergedTags) return
  setVaultProperty(journalPath, "tags", mergedTags, "list", vault)
}

/** Build the date directory path for plans using the configured scheme. */
export function getPlanDatePath(config: Config, dateParts: DateParts): string {
  return `${config.plan.path}/${formatDatePath(config.plan.date_scheme, dateParts)}`
}

/** Build the date directory path for skills using the configured scheme. */
export function getSkillDatePath(config: Config, dateParts: DateParts): string {
  return `${config.skills.path}/${formatDatePath(config.skills.date_scheme, dateParts)}`
}

/** Build the Obsidian vault path for the daily journal note on a given date. */
export function getJournalPathForDate(config: Config, date: Date): string {
  const parts = getDatePartsFor(date)
  return `${config.journal.path}/${formatDatePath(config.journal.date_scheme, parts)}`
}

/** Build the Obsidian vault path for today's daily journal note. */
export function getJournalPath(config: Config): string {
  return getJournalPathForDate(config, new Date())
}

/** Append content to a journal note, creating the note first if it doesn't exist. Content is escaped for the Obsidian CLI automatically. */
export function appendToJournal(content: string, journalPath: string, vault?: string): void {
  const pathWithExt = ensureMdExt(journalPath)
  const escaped = escapeForObsidianAppend(content)
  const result = runObsidian(["append", `path=${pathWithExt}`, `content=${escaped}`], vault)
  if (result.exitCode !== 0) {
    // File doesn't exist yet — create it, then append
    runObsidian(["create", `path=${pathWithExt}`, "content= "], vault)
    runObsidian(["append", `path=${pathWithExt}`, `content=${escaped}`], vault)
  }
}

/** Properties to set or update on the daily journal note frontmatter. */
export interface JournalFrontmatterProps {
  date: string
  day: string
  project: string
  tags: string
}

/** Set or update frontmatter properties on the daily journal note (date, day, plans count, projects list, tags). */
export function updateJournalFrontmatter(
  journalPath: string,
  props: JournalFrontmatterProps,
  vault?: string,
): void {
  if (!journalPath) return

  // date and day: idempotent set
  setVaultProperty(journalPath, "date", props.date, "date", vault)
  setVaultProperty(journalPath, "day", props.day, "text", vault)

  // plans: read current count, increment by 1
  const plansRaw = readVaultProperty(journalPath, "plans", vault)
  const currentPlans = parseInt(plansRaw ?? "", 10) || 0
  setVaultProperty(journalPath, "plans", `${currentPlans + 1}`, "number", vault)

  // projects: read current list, add project if not present
  if (props.project) {
    const projRaw = readVaultProperty(journalPath, "projects", vault)
    const existingProjects = projRaw ? projRaw.split("\n").filter((l) => l.trim()) : []
    if (!existingProjects.includes(props.project)) {
      const merged = [...existingProjects, props.project].join(",")
      setVaultProperty(journalPath, "projects", merged, "list", vault)
    }
  }

  // tags: delegate to existing mergeTagsOnDailyNote
  mergeTagsOnDailyNote(props.tags, journalPath, vault)
}

/** Try to append a revision to an existing callout in the journal; if the callout doesn't exist, create a new one via the Obsidian CLI. When `fallbackJournalPath` is provided, the fallback write targets that path instead of `journalPath` (used when the append target is a prior day's journal). */
export async function appendOrCreateCallout(
  title: string,
  revision: string,
  project: string,
  source: string,
  journalPath: string,
  vaultPath: string | null,
  vault?: string,
  fallbackJournalPath?: string,
): Promise<void> {
  let appended = false
  if (vaultPath) {
    const fullJournalPath = join(vaultPath, ensureMdExt(journalPath))
    appended = await appendRevisionToCallout(title, revision, fullJournalPath, journalPath, vault)
  }
  if (!appended) {
    const callout = formatJournalCallout(title, project, source, revision)
    appendToJournal(`\n\n${callout}`, fallbackJournalPath ?? journalPath, vault)
  }
}
