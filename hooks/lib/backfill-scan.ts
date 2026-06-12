// backfill-scan.ts — Shared read-only vault scan for the frontmatter backfill
// runner and its estimator. Direct fs reads only; never mutates the vault.

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type BackfillDocType,
  classifyDoc,
  type NoteUpgrade,
  upgradeNoteContent,
} from "./backfill.ts"
import type { Config } from "./types.ts"

/** A note that needs upgrading, with its precomputed new content. */
export interface PendingUpgrade {
  relPath: string
  docType: BackfillDocType
  upgrade: NoteUpgrade
}

/** Aggregate results of scanning the plugin-generated vault trees. */
export interface ScanResult {
  /** Markdown files visited across the plan/journal/session trees. */
  scanned: number
  /** Files with nothing to do: already at the current standard, or not safely
   *  upgradable (no parseable frontmatter). */
  current: number
  /** Files skipped before inspection: unknown names, e2e/state artifacts, unreadable. */
  skipped: number
  /** Total bytes of all scanned markdown files. */
  totalBytes: number
  /** Notes that need upgrading, ready to apply. */
  queue: PendingUpgrade[]
  /** Pending change counts per frontmatter field (type, date, ...). */
  changeCounts: Map<string, number>
  /** Pending upgrade counts per doc type (plan, summary, ...). */
  byDocType: Map<string, number>
}

/** Recursively collect vault-relative .md paths under a vault folder. */
export function collectMarkdownFiles(vaultPath: string, folderRel: string): string[] {
  const results: string[] = []
  const walk = (rel: string): void => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(join(vaultPath, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(childRel)
      else if (entry.name.endsWith(".md")) results.push(childRel)
    }
  }
  walk(folderRel)
  return results
}

/** Scan the plugin's vault trees and compute every pending upgrade. Read-only;
 *  per-file failures count as skipped rather than aborting the scan. */
export function scanVault(
  config: Config,
  vaultPath: string,
  limit: number = Number.POSITIVE_INFINITY,
): ScanResult {
  const paths = {
    planPath: config.plan.path,
    journalPath: config.journal.path,
    sessionPath: config.session.path,
  }
  const roots = [...new Set([paths.planPath, paths.journalPath, paths.sessionPath])]
  const result: ScanResult = {
    scanned: 0,
    current: 0,
    skipped: 0,
    totalBytes: 0,
    queue: [],
    changeCounts: new Map(),
    byDocType: new Map(),
  }

  for (const root of roots) {
    for (const relPath of collectMarkdownFiles(vaultPath, root)) {
      if (result.queue.length >= limit) return result
      result.scanned++
      const docType = classifyDoc(relPath, paths)
      if (!docType) {
        result.skipped++
        continue
      }
      let content: string
      try {
        content = readFileSync(join(vaultPath, relPath), "utf8")
      } catch {
        result.skipped++
        continue
      }
      result.totalBytes += Buffer.byteLength(content)
      const upgrade = upgradeNoteContent(relPath, content, docType)
      if (!upgrade) {
        result.current++
        continue
      }
      for (const change of upgrade.changes) {
        result.changeCounts.set(change.key, (result.changeCounts.get(change.key) ?? 0) + 1)
      }
      result.byDocType.set(docType, (result.byDocType.get(docType) ?? 0) + 1)
      result.queue.push({ relPath, docType, upgrade })
    }
  }
  return result
}
