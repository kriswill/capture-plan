#!/usr/bin/env bun
// backfill-estimate.ts — Read-only estimator for the frontmatter backfill.
// Reports hardware specs, the size of the plugin-generated vault content,
// the pending upgrade workload, and a calibrated runtime estimate.
//
//   bun hooks/backfill-estimate.ts [--cwd PATH]
//
// Nothing in the vault is modified. Calibration issues a few metadata-only
// Obsidian CLI queries to measure real round-trip latency on this machine.

import { cpus, totalmem } from "node:os"
import { scanVault } from "./lib/backfill-scan.ts"
import { formatDuration, formatNumber, getVaultPath, loadConfig, runObsidian } from "./shared.ts"

/** Writes cost roughly this multiple of a metadata query round trip
 *  (file create + vault index update vs. an info lookup). */
const WRITE_LATENCY_FACTOR = 2
const CALIBRATION_SAMPLES = 5

function parseCwd(argv: string[]): string | undefined {
  const idx = argv.indexOf("--cwd")
  return idx >= 0 ? argv[idx + 1] : undefined
}

/** Median of a numeric sample list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Measure Obsidian CLI round-trip latency with metadata-only queries. */
function calibrateCliLatencyMs(vault?: string): number {
  const samples: number[] = []
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
    const start = Date.now()
    runObsidian(["vault", "info=name"], vault)
    samples.push(Date.now() - start)
  }
  return median(samples)
}

async function main(): Promise<void> {
  const config = await loadConfig(parseCwd(process.argv.slice(2)))
  const vaultPath = getVaultPath(config.vault)
  if (!vaultPath) {
    console.log(`estimate: cannot resolve vault path (vault=${config.vault ?? "default"})`)
    process.exit(1)
  }

  const cores = cpus()
  const cpuModel = cores[0]?.model ?? "unknown CPU"
  const memGb = (totalmem() / 1024 ** 3).toFixed(0)
  const concurrency = Math.max(2, Math.min(8, cores.length - 2))

  const scanStart = Date.now()
  const scan = scanVault(config, vaultPath)
  const scanMs = Date.now() - scanStart

  const cliLatencyMs = calibrateCliLatencyMs(config.vault)
  const perWriteMs = cliLatencyMs * WRITE_LATENCY_FACTOR
  const applyMs = (scan.queue.length * perWriteMs) / concurrency
  const totalMs = scanMs + applyMs

  console.log("## Backfill estimate (read-only — nothing was modified)")
  console.log("")
  console.log("### Hardware")
  console.log(`- CPU: ${cpuModel} (${cores.length} cores)`)
  console.log(`- Memory: ${memGb} GB`)
  console.log(`- Backfill concurrency: ${concurrency} parallel Obsidian CLI workers`)
  console.log(`- Obsidian CLI round trip: ~${cliLatencyMs}ms (median of ${CALIBRATION_SAMPLES})`)
  console.log("")
  console.log("### Vault (plugin-generated content)")
  console.log(`- Vault: ${config.vault ?? "(default)"} at ${vaultPath}`)
  console.log(
    `- Trees: ${[...new Set([config.plan.path, config.journal.path, config.session.path])].join(", ")}`,
  )
  console.log(
    `- Files: ${formatNumber(scan.scanned)} markdown notes, ${(scan.totalBytes / 1024 ** 2).toFixed(1)} MB (scanned in ${formatDuration(scanMs)})`,
  )
  console.log("")
  console.log("### Pending work")
  if (scan.queue.length === 0) {
    console.log("- Nothing to do — every note is already at the current frontmatter standard.")
    process.exit(0)
  }
  console.log(
    `- ${formatNumber(scan.queue.length)} notes need upgrading (${formatNumber(scan.current)} already current, ${formatNumber(scan.skipped)} skipped)`,
  )
  const byField = [...scan.changeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${formatNumber(n)}`)
    .join(", ")
  console.log(`- Fields to add/normalize: ${byField}`)
  const byType = [...scan.byDocType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}: ${formatNumber(n)}`)
    .join(", ")
  console.log(`- By doc type: ${byType}`)
  console.log("")
  console.log("### Estimated runtime")
  console.log(
    `- ~${formatDuration(totalMs)} (${formatDuration(Math.round(totalMs / 2))}–${formatDuration(totalMs * 2)} depending on Obsidian's indexer load)`,
  )
  console.log("")
  console.log(
    "Run /backfill-frontmatter to apply. The run is interruptible (Ctrl-C / kill) and resumable — re-running skips notes that are already upgraded.",
  )
  process.exit(0)
}

main()
