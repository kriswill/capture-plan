#!/usr/bin/env bun
// backfill-frontmatter.ts — One-time upgrade of legacy vault notes to the
// current frontmatter standard (type, date, duration_s, normalized model +
// context_window).
//
// Spawned automatically (detached) when syncBases creates the managed .base
// files net-new; also runnable manually:
//
//   bun hooks/backfill-frontmatter.ts [--dry-run] [--limit N] [--concurrency N] [--cwd PATH] [--quiet]
//
// Sources only the note's own frontmatter and its vault path — never Claude
// Code session data, which may no longer exist. Reads are direct fs reads
// (safe); all writes go through the Obsidian CLI per the vault mutation rule.
// Idempotent: already-conformant notes cost zero writes, so re-runs are cheap.

import { readdirSync, readFileSync } from "node:fs"
import { cpus } from "node:os"
import { join } from "node:path"
import {
  type BackfillDocType,
  classifyDoc,
  type NoteUpgrade,
  upgradeNoteContent,
} from "./lib/backfill.ts"
import { debugLog, getVaultPath, loadConfig, runObsidianAsync } from "./shared.ts"

const DEBUG_LOG = "/tmp/capture-backfill-debug.log"

interface CliOptions {
  dryRun: boolean
  limit: number
  concurrency: number
  cwd?: string
  quiet: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false,
    limit: Number.POSITIVE_INFINITY,
    concurrency: Math.max(2, Math.min(8, cpus().length - 2)),
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") opts.dryRun = true
    else if (arg === "--quiet") opts.quiet = true
    else if (arg === "--limit") opts.limit = Number.parseInt(argv[++i] ?? "", 10) || opts.limit
    else if (arg === "--concurrency")
      opts.concurrency = Number.parseInt(argv[++i] ?? "", 10) || opts.concurrency
    else if (arg === "--cwd") opts.cwd = argv[++i]
  }
  return opts
}

/** Recursively collect vault-relative .md paths under a vault folder. */
function collectMarkdownFiles(vaultPath: string, folderRel: string): string[] {
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

/** Run an async worker over items with bounded concurrency. Worker errors are
 *  the worker's responsibility — the pool itself never rejects early. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        await worker(items[i], i)
      }
    },
  )
  await Promise.all(runners)
}

interface PendingUpgrade {
  relPath: string
  docType: BackfillDocType
  upgrade: NoteUpgrade
}

/** Apply one upgrade: whole-file frontmatter rewrite via `create overwrite`,
 *  falling back to per-property `property:set` calls if that fails (e.g. a
 *  file too large to pass as a process argument). Returns how it landed. */
async function applyUpgrade(
  pending: PendingUpgrade,
  vault?: string,
): Promise<"written" | "fallback" | "failed"> {
  const { relPath, upgrade } = pending
  const create = await runObsidianAsync(
    ["create", `path=${relPath}`, `content=${upgrade.content}`, "overwrite", "silent"],
    vault,
  )
  if (create.exitCode === 0) return "written"

  let allOk = true
  for (const change of upgrade.changes) {
    const set = await runObsidianAsync(
      [
        "property:set",
        `name=${change.key}`,
        `value=${change.value}`,
        `type=${change.propType}`,
        `path=${relPath}`,
      ],
      vault,
    )
    if (set.exitCode !== 0) allOk = false
  }
  return allOk ? "fallback" : "failed"
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const log = (msg: string): void => {
    if (!opts.quiet) console.log(msg)
    debugLog(`${msg}\n`, DEBUG_LOG)
  }
  const startedAt = Date.now()
  debugLog(`=== BACKFILL ${new Date().toISOString()} ${JSON.stringify(opts)} ===\n`, DEBUG_LOG)

  const config = await loadConfig(opts.cwd)
  const vaultPath = getVaultPath(config.vault)
  if (!vaultPath) {
    log(`backfill: cannot resolve vault path (vault=${config.vault ?? "default"}), aborting`)
    process.exit(1)
  }

  const paths = {
    planPath: config.plan.path,
    journalPath: config.journal.path,
    sessionPath: config.session.path,
  }
  const roots = [...new Set([paths.planPath, paths.journalPath, paths.sessionPath])]

  // Scan: direct fs reads, no vault mutation
  const stats = { scanned: 0, unclassified: 0, current: 0 }
  const queue: PendingUpgrade[] = []
  const changeCounts = new Map<string, number>()
  for (const root of roots) {
    for (const relPath of collectMarkdownFiles(vaultPath, root)) {
      stats.scanned++
      const docType = classifyDoc(relPath, paths)
      if (!docType) {
        stats.unclassified++
        continue
      }
      let content: string
      try {
        content = readFileSync(join(vaultPath, relPath), "utf8")
      } catch {
        stats.unclassified++
        continue
      }
      const upgrade = upgradeNoteContent(relPath, content, docType)
      if (!upgrade) {
        stats.current++
        continue
      }
      for (const change of upgrade.changes) {
        changeCounts.set(change.key, (changeCounts.get(change.key) ?? 0) + 1)
      }
      queue.push({ relPath, docType, upgrade })
      if (queue.length >= opts.limit) break
    }
    if (queue.length >= opts.limit) break
  }

  const changeSummary =
    [...changeCounts.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"
  log(
    `backfill: scanned ${stats.scanned} files — ${queue.length} need upgrades, ` +
      `${stats.current} already current, ${stats.unclassified} skipped | changes: ${changeSummary}`,
  )

  if (opts.dryRun) {
    for (const p of queue.slice(0, 20)) {
      log(
        `  would update [${p.docType}] ${p.relPath}: ${p.upgrade.changes.map((c) => c.key).join(", ")}`,
      )
    }
    if (queue.length > 20) log(`  ... and ${queue.length - 20} more`)
    return
  }

  // Apply with a bounded worker pool
  const outcome = { written: 0, fallback: 0, failed: [] as string[] }
  let done = 0
  await runPool(queue, opts.concurrency, async (pending) => {
    try {
      const result = await applyUpgrade(pending, config.vault)
      if (result === "written") outcome.written++
      else if (result === "fallback") outcome.fallback++
      else outcome.failed.push(pending.relPath)
    } catch (err) {
      outcome.failed.push(pending.relPath)
      debugLog(`backfill error on ${pending.relPath}: ${err}\n`, DEBUG_LOG)
    }
    done++
    if (done % 250 === 0) log(`backfill: ${done}/${queue.length} applied...`)
  })

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(
    `backfill: done in ${elapsed}s — ${outcome.written} rewritten, ` +
      `${outcome.fallback} via property fallback, ${outcome.failed.length} failed`,
  )
  for (const failed of outcome.failed.slice(0, 20)) log(`  failed: ${failed}`)
  // Explicit exit — lingering subprocess stream handles must not keep the
  // (possibly detached) process alive after the work is done.
  process.exit(outcome.failed.length > 0 ? 1 : 0)
}

main()
