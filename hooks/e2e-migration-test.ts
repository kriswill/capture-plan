#!/usr/bin/env bun
// e2e-migration-test.ts — E2E roundtrip test for vault layout migration
// Usage: bun hooks/e2e-migration-test.ts --path plan|journal --from SCHEME --to SCHEME
// Tests roundtrip migration with content integrity verification.
// Uses real Obsidian CLI and vault; verifies no errant files or data loss.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./lib/config.ts"
import { DATE_SCHEMES, type DateScheme } from "./lib/dates.ts"
import {
  computeJournalMoves,
  computePlanMoves,
  executeMoves,
  type MoveEntry,
} from "./lib/migration.ts"
import { getVaultPath } from "./lib/obsidian.ts"

type PathType = "plan" | "journal"

interface Args {
  pathType: PathType
  fromScheme: DateScheme
  toScheme: DateScheme
}

interface CheckResult {
  seq: number
  phase: string
  check: string
  pass: boolean
  detail: string
}

interface FileSnapshot {
  path: string
  hash: string
  size: number
}

const results: CheckResult[] = []
let seq = 0

function record(phase: string, check: string, pass: boolean, detail = ""): void {
  seq++
  results.push({ seq, phase, check, pass, detail })
  const mark = pass ? "✓" : "✗"
  const detailStr = detail ? ` (${detail})` : ""
  console.log(`  ${mark} ${check}${detailStr}`)
}

function parseArgs(argv: string[]): Args {
  const pathIdx = argv.indexOf("--path")
  const fromIdx = argv.indexOf("--from")
  const toIdx = argv.indexOf("--to")

  const pathType = pathIdx >= 0 ? argv[pathIdx + 1] : undefined
  const fromScheme = fromIdx >= 0 ? argv[fromIdx + 1] : undefined
  const toScheme = toIdx >= 0 ? argv[toIdx + 1] : undefined

  if (!pathType || !["plan", "journal"].includes(pathType)) {
    console.error("Error: --path must be 'plan' or 'journal'")
    process.exit(1)
  }
  if (!fromScheme || !DATE_SCHEMES.includes(fromScheme as DateScheme)) {
    console.error(`Error: --from must be one of: ${DATE_SCHEMES.join(", ")}`)
    process.exit(1)
  }
  if (!toScheme || !DATE_SCHEMES.includes(toScheme as DateScheme)) {
    console.error(`Error: --to must be one of: ${DATE_SCHEMES.join(", ")}`)
    process.exit(1)
  }
  if (fromScheme === toScheme) {
    console.error("Error: --from and --to must be different schemes")
    process.exit(1)
  }

  return {
    pathType: pathType as PathType,
    fromScheme: fromScheme as DateScheme,
    toScheme: toScheme as DateScheme,
  }
}

function md5File(path: string): string {
  const content = readFileSync(path)
  return createHash("md5").update(content).digest("hex")
}

function walkFiles(basePath: string, prefix = ""): FileSnapshot[] {
  const snapshots: FileSnapshot[] = []
  try {
    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      const fullPath = join(basePath, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        snapshots.push(...walkFiles(fullPath, relPath))
      } else if (entry.isFile()) {
        snapshots.push({ path: relPath, hash: md5File(fullPath), size: statSync(fullPath).size })
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return snapshots
}

function walkDirs(basePath: string, prefix = ""): string[] {
  const dirs: string[] = []
  try {
    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
        dirs.push(relPath)
        dirs.push(...walkDirs(join(basePath, entry.name), relPath))
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return dirs
}

function compareSnapshots(
  before: FileSnapshot[],
  after: FileSnapshot[],
): { missing: string[]; extra: string[]; changed: string[] } {
  const beforeMap = new Map(before.map((f) => [f.path, f]))
  const afterMap = new Map(after.map((f) => [f.path, f]))
  const missing: string[] = []
  const extra: string[] = []
  const changed: string[] = []

  for (const [path, snap] of beforeMap) {
    const a = afterMap.get(path)
    if (!a) missing.push(path)
    else if (a.hash !== snap.hash) changed.push(path)
  }
  for (const path of afterMap.keys()) {
    if (!beforeMap.has(path)) extra.push(path)
  }
  return { missing, extra, changed }
}

/** Strip the base prefix from a vault-relative path to get the local relative portion. */
function stripBase(vaultRel: string, baseRel: string): string {
  if (vaultRel.startsWith(`${baseRel}/`)) return vaultRel.slice(baseRel.length + 1)
  return vaultRel
}

/** Check if a file snapshot path falls under one of the move source paths (vault-relative). */
function isMigratable(filePath: string, moves: MoveEntry[], baseRel: string): boolean {
  for (const move of moves) {
    const moveLocal = stripBase(move.from, baseRel)
    if (filePath === moveLocal || filePath.startsWith(`${moveLocal}/`)) return true
  }
  return false
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const { pathType, fromScheme, toScheme } = args

  console.log(`capture-plan migration e2e test (${pathType})`)
  console.log(`roundtrip: ${fromScheme} → ${toScheme} → ${fromScheme}`)
  console.log("================================\n")

  // ---- Phase 0: Preflight ----
  console.log("Preflight")

  const obsAvailable = Bun.which("obsidian") !== null
  record("preflight", "obsidian CLI available", obsAvailable)
  if (!obsAvailable) {
    console.log("\nFatal: obsidian CLI not found.")
    process.exit(1)
  }

  const config = await loadConfig()
  const pathConfig = config[pathType]
  const baseRel = pathConfig.path
  record("preflight", "config loaded", true, `${pathType}=${baseRel} (${pathConfig.date_scheme})`)

  const vaultPath = getVaultPath(config.vault)
  record("preflight", "vault accessible", vaultPath !== null, vaultPath ?? "null")
  if (!vaultPath) {
    console.log("\nFatal: cannot resolve vault path.")
    process.exit(1)
  }

  const basePath = join(vaultPath, baseRel)
  record("preflight", `${pathType} dir exists`, existsSync(basePath))
  if (!existsSync(basePath)) {
    console.log(`\nFatal: ${pathType} directory not found at ${basePath}`)
    process.exit(1)
  }

  // Compute forward moves to identify migratable items (vault-relative paths)
  const computeMoves = pathType === "journal" ? computeJournalMoves : computePlanMoves
  const forwardMoves = computeMoves(baseRel, fromScheme, toScheme, config.vault)

  record(
    "preflight",
    `${fromScheme} ${pathType} items present`,
    forwardMoves.length > 0,
    `${forwardMoves.length} items to migrate`,
  )
  if (forwardMoves.length === 0) {
    console.log(`\nFatal: no ${fromScheme} ${pathType} items found. Cannot run roundtrip test.`)
    process.exit(1)
  }
  console.log("")

  // ---- Phase 1: Snapshot ----
  console.log("Snapshot")

  const beforeFiles = walkFiles(basePath)
  const beforeDirs = walkDirs(basePath)
  record("snapshot", "files inventoried", beforeFiles.length > 0, `${beforeFiles.length} files`)
  record("snapshot", "dirs inventoried", true, `${beforeDirs.length} directories`)

  const migratableFiles = beforeFiles.filter((f) => isMigratable(f.path, forwardMoves, baseRel))
  const stationaryFiles = beforeFiles.filter((f) => !isMigratable(f.path, forwardMoves, baseRel))

  record(
    "snapshot",
    `migratable ${fromScheme} files found`,
    migratableFiles.length > 0,
    `${migratableFiles.length} files`,
  )
  record(
    "snapshot",
    "stationary files cataloged",
    true,
    `${stationaryFiles.length} files won't move`,
  )

  for (const f of migratableFiles) {
    console.log(`    migrate: ${f.path}  ${f.hash}`)
  }
  for (const f of stationaryFiles) {
    console.log(`    static:  ${f.path}  ${f.hash}`)
  }
  console.log("")

  // ---- Phase 2: Forward migration ----
  console.log(`Forward: ${fromScheme} → ${toScheme}`)

  record("forward", "moves computed", forwardMoves.length > 0, `${forwardMoves.length} moves`)

  for (const move of forwardMoves) {
    console.log(`    ${stripBase(move.from, baseRel)} → ${stripBase(move.to, baseRel)}`)
  }

  const forwardMoved = executeMoves(forwardMoves, config.vault)
  record(
    "forward",
    "all moves executed",
    forwardMoved === forwardMoves.length,
    `${forwardMoved}/${forwardMoves.length}`,
  )

  // Skip cleanEmptyDirs — Obsidian CLI manages vault index, no filesystem cleanup needed.

  // Verify each migrated item exists with correct hash
  let allForwardOk = true
  for (const orig of migratableFiles) {
    const move = forwardMoves.find((m) => {
      const moveLocal = stripBase(m.from, baseRel)
      return orig.path === moveLocal || orig.path.startsWith(`${moveLocal}/`)
    })
    if (!move) {
      record("forward", `move found for ${orig.path}`, false, "no matching move")
      allForwardOk = false
      continue
    }
    const moveLocal = stripBase(move.from, baseRel)
    const suffix = orig.path === moveLocal ? "" : orig.path.slice(moveLocal.length)
    const targetAbs = join(vaultPath, move.to) + suffix
    if (!existsSync(targetAbs)) {
      record("forward", `${stripBase(move.to, baseRel)}${suffix} exists`, false, "missing")
      allForwardOk = false
      continue
    }
    const hash = md5File(targetAbs)
    if (hash !== orig.hash) {
      record(
        "forward",
        `${stripBase(move.to, baseRel)}${suffix} hash`,
        false,
        `expected ${orig.hash}, got ${hash}`,
      )
      allForwardOk = false
    }
  }
  record("forward", `all ${toScheme} files exist with correct hashes`, allForwardOk)

  // Verify old files are gone
  let allOldGone = true
  for (const orig of migratableFiles) {
    if (existsSync(join(basePath, orig.path))) {
      record("forward", `${orig.path} removed`, false, "still exists")
      allOldGone = false
    }
  }
  record("forward", `all old ${fromScheme} files removed`, allOldGone)

  // Verify stationary files untouched
  let allStationaryOk = true
  for (const f of stationaryFiles) {
    const fullPath = join(basePath, f.path)
    if (!existsSync(fullPath)) {
      record("forward", `stationary ${f.path} exists`, false, "missing")
      allStationaryOk = false
    } else if (md5File(fullPath) !== f.hash) {
      record("forward", `stationary ${f.path} hash`, false, "changed")
      allStationaryOk = false
    }
  }
  record("forward", "all stationary files unchanged", allStationaryOk)

  // Check total file count — should be identical
  const afterForwardFiles = walkFiles(basePath)
  record(
    "forward",
    "no errant files",
    afterForwardFiles.length === beforeFiles.length,
    `before=${beforeFiles.length}, after=${afterForwardFiles.length}`,
  )

  // Check no junk dirs created in CWD by the migration
  const cwdErrant = existsSync(join(process.cwd(), pathConfig.path))
  record("forward", "no errant dirs in CWD", !cwdErrant)

  console.log("")

  // ---- Phase 3: Reverse migration ----
  console.log(`Reverse: ${toScheme} → ${fromScheme}`)

  const reverseMoves = computeMoves(baseRel, toScheme, fromScheme, config.vault)
  record("reverse", "moves computed", reverseMoves.length > 0, `${reverseMoves.length} moves`)
  record(
    "reverse",
    "move count matches forward",
    reverseMoves.length === forwardMoves.length,
    `${reverseMoves.length} vs ${forwardMoves.length}`,
  )

  for (const move of reverseMoves) {
    console.log(`    ${stripBase(move.from, baseRel)} → ${stripBase(move.to, baseRel)}`)
  }

  const reverseMoved = executeMoves(reverseMoves, config.vault)
  record(
    "reverse",
    "all moves executed",
    reverseMoved === reverseMoves.length,
    `${reverseMoved}/${reverseMoves.length}`,
  )

  // Verify all original files restored with correct hashes
  let allRestoredOk = true
  for (const orig of migratableFiles) {
    const fullPath = join(basePath, orig.path)
    if (!existsSync(fullPath)) {
      record("reverse", `${orig.path} restored`, false, "missing")
      allRestoredOk = false
    } else {
      const hash = md5File(fullPath)
      if (hash !== orig.hash) {
        record("reverse", `${orig.path} hash`, false, `expected ${orig.hash}, got ${hash}`)
        allRestoredOk = false
      }
    }
  }
  record("reverse", `all ${fromScheme} files restored with correct hashes`, allRestoredOk)

  // Verify forward-target files are gone
  let allForwardGone = true
  for (const move of forwardMoves) {
    const targetAbs = join(vaultPath, move.to)
    if (existsSync(targetAbs)) {
      record("reverse", `${toScheme} ${stripBase(move.to, baseRel)} removed`, false, "still exists")
      allForwardGone = false
    }
  }
  record("reverse", `all ${toScheme} files removed`, allForwardGone)

  // Verify stationary files still untouched
  let stationaryStillOk = true
  for (const f of stationaryFiles) {
    const fullPath = join(basePath, f.path)
    if (!existsSync(fullPath)) {
      record("reverse", `stationary ${f.path} exists`, false, "missing")
      stationaryStillOk = false
    } else if (md5File(fullPath) !== f.hash) {
      record("reverse", `stationary ${f.path} hash`, false, "changed")
      stationaryStillOk = false
    }
  }
  record("reverse", "all stationary files unchanged", stationaryStillOk)

  console.log("")

  // ---- Phase 4: Final integrity comparison ----
  console.log("Integrity")

  const afterFiles = walkFiles(basePath)
  const afterDirs = walkDirs(basePath)

  record(
    "integrity",
    "file count matches original",
    afterFiles.length === beforeFiles.length,
    `before=${beforeFiles.length}, after=${afterFiles.length}`,
  )
  record(
    "integrity",
    "dir count matches original",
    afterDirs.length === beforeDirs.length,
    `before=${beforeDirs.length}, after=${afterDirs.length}`,
  )

  const { missing, extra, changed } = compareSnapshots(beforeFiles, afterFiles)
  record(
    "integrity",
    "no missing files",
    missing.length === 0,
    missing.length > 0 ? missing.join(", ") : "",
  )
  record(
    "integrity",
    "no extra files",
    extra.length === 0,
    extra.length > 0 ? extra.join(", ") : "",
  )
  record(
    "integrity",
    "no changed files",
    changed.length === 0,
    changed.length > 0 ? changed.join(", ") : "",
  )

  const missingDirs = beforeDirs.filter((d) => !afterDirs.includes(d))
  const extraDirs = afterDirs.filter((d) => !beforeDirs.includes(d))
  record(
    "integrity",
    "no missing dirs",
    missingDirs.length === 0,
    missingDirs.length > 0 ? missingDirs.join(", ") : "",
  )
  record(
    "integrity",
    "no extra dirs",
    extraDirs.length === 0,
    extraDirs.length > 0 ? extraDirs.join(", ") : "",
  )

  console.log("")

  // ---- Summary ----
  const passed = results.filter((r) => r.pass).length
  const total = results.length
  const allPass = passed === total

  console.log(`Result: ${passed}/${total} passed${allPass ? "" : ` (${total - passed} failed)`}`)
  process.exit(allPass ? 0 : 1)
}

main()
