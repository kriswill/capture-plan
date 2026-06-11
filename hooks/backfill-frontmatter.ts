#!/usr/bin/env bun
// backfill-frontmatter.ts — Upgrade legacy vault notes to the current
// frontmatter standard (type, date, duration_s, normalized model +
// context_window). Invoked via the /backfill-frontmatter skill, or manually:
//
//   bun hooks/backfill-frontmatter.ts [--dry-run] [--limit N] [--concurrency N] [--cwd PATH] [--quiet]
//
// Sources only the note's own frontmatter and its vault path — never Claude
// Code session data, which may no longer exist. Reads are direct fs reads
// (safe); all writes go through the Obsidian CLI per the vault mutation rule.
//
// Interruptible and resumable: SIGINT/SIGTERM stop the worker pool after
// in-flight writes finish, and a re-run skips notes that are already at the
// current standard, picking up exactly where the previous run left off.

import { cpus } from "node:os"
import { type PendingUpgrade, scanVault } from "./lib/backfill-scan.ts"
import { debugLog, formatDuration, getVaultPath, loadConfig, runObsidianAsync } from "./shared.ts"

const DEBUG_LOG = "/tmp/capture-backfill-debug.log"
const PROGRESS_EVERY = 100

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

/** Run an async worker over items with bounded concurrency. Stops picking new
 *  items once shouldStop() returns true; in-flight items finish cleanly. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (!shouldStop()) {
        const i = next++
        if (i >= items.length) return
        await worker(items[i], i)
      }
    },
  )
  await Promise.all(runners)
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

  let interrupted = false
  const onSignal = (): void => {
    interrupted = true
    log(
      "backfill: interrupt received — finishing in-flight writes, then stopping (re-run to resume)",
    )
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const config = await loadConfig(opts.cwd)
  const vaultPath = getVaultPath(config.vault)
  if (!vaultPath) {
    log(`backfill: cannot resolve vault path (vault=${config.vault ?? "default"}), aborting`)
    process.exit(1)
  }

  const scan = scanVault(config, vaultPath, opts.limit)
  const queue = scan.queue
  const changeSummary =
    [...scan.changeCounts.entries()].map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"
  log(
    `backfill: scanned ${scan.scanned} files — ${queue.length} need upgrades, ` +
      `${scan.current} already current, ${scan.skipped} skipped | changes: ${changeSummary}`,
  )

  if (opts.dryRun) {
    for (const p of queue.slice(0, 20)) {
      log(
        `  would update [${p.docType}] ${p.relPath}: ${p.upgrade.changes.map((c) => c.key).join(", ")}`,
      )
    }
    if (queue.length > 20) log(`  ... and ${queue.length - 20} more`)
    process.exit(0)
  }

  if (queue.length === 0) {
    log("backfill: nothing to do — vault is already at the current frontmatter standard")
    process.exit(0)
  }

  // Apply with a bounded worker pool
  const outcome = { written: 0, fallback: 0, failed: [] as string[] }
  let done = 0
  const applyStart = Date.now()
  await runPool(
    queue,
    opts.concurrency,
    async (pending) => {
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
      if (done % PROGRESS_EVERY === 0) {
        const rate = done / Math.max((Date.now() - applyStart) / 1000, 0.001)
        const etaMs = ((queue.length - done) / Math.max(rate, 0.1)) * 1000
        log(
          `backfill: ${done}/${queue.length} (${rate.toFixed(0)}/s, ~${formatDuration(etaMs)} remaining)`,
        )
      }
    },
    () => interrupted,
  )

  const elapsed = formatDuration(Date.now() - startedAt)
  const verb = interrupted ? `interrupted after ${done} of ${queue.length}` : "done"
  log(
    `backfill: ${verb} in ${elapsed} — ${outcome.written} rewritten, ` +
      `${outcome.fallback} via property fallback, ${outcome.failed.length} failed`,
  )
  if (interrupted) {
    log("backfill: safe to resume — re-running skips notes that are already upgraded")
  }
  for (const failed of outcome.failed.slice(0, 20)) log(`  failed: ${failed}`)
  // Explicit exit — lingering subprocess stream handles must not keep the
  // process alive after the work is done.
  process.exit(interrupted ? 130 : outcome.failed.length > 0 ? 1 : 0)
}

main()
