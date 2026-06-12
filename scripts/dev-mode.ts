#!/usr/bin/env bun
/**
 * Toggle dev mode for the capture-plan plugin.
 * Symlinks the plugin cache and marketplace directories to the local repo
 * so that hook and skill edits take effect without releasing.
 *
 * Usage: bun scripts/dev-mode.ts <start|stop>
 */

import { existsSync, lstatSync, renameSync, rmdirSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { claudeConfigDir } from "../hooks/lib/config.ts"

interface PluginMeta {
  name: string
  author: { name: string }
}

interface PackageMeta {
  version: string
}

const repoRoot = resolve(import.meta.dir, "..")
const plugin = (await Bun.file(join(repoRoot, ".claude-plugin", "plugin.json")).json()) as PluginMeta
const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as PackageMeta

const owner = plugin.author.name
const name = plugin.name
const { version } = pkg

const configDir = claudeConfigDir()
const cachePath = join(configDir, "plugins", "cache", owner, name, version)
const cacheBackup = `${cachePath}.bak`
const marketPath = join(configDir, "plugins", "marketplaces", owner)
const marketBackup = `${marketPath}.bak`
const symlinkType = process.platform === "win32" ? "junction" : undefined

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function ensureInstalled(p: string): void {
  if (!existsSync(p)) {
    console.error(`Path not found: ${p}`)
    console.error(`Install the plugin first: claude plugin install ${name}@${owner}`)
    process.exit(1)
  }
}

function start(): void {
  const cacheLinked = isSymlink(cachePath)
  const marketLinked = isSymlink(marketPath)

  if (cacheLinked && marketLinked) {
    console.log("Dev mode is already active — both paths are symlinked.")
    return
  }

  if (!cacheLinked) {
    ensureInstalled(cachePath)
    if (existsSync(cacheBackup)) {
      console.error(`Backup already exists: ${cacheBackup}`)
      console.error("Remove it manually before starting dev mode.")
      process.exit(1)
    }
    renameSync(cachePath, cacheBackup)
    symlinkSync(repoRoot, cachePath, symlinkType)
    console.log(`Symlinked cache: ${cachePath} → ${repoRoot}`)
  } else {
    console.log("Cache already symlinked, skipping.")
  }

  if (!marketLinked) {
    ensureInstalled(marketPath)
    if (existsSync(marketBackup)) {
      console.error(`Backup already exists: ${marketBackup}`)
      console.error("Remove it manually before starting dev mode.")
      process.exit(1)
    }
    renameSync(marketPath, marketBackup)
    symlinkSync(repoRoot, marketPath, symlinkType)
    console.log(`Symlinked marketplace: ${marketPath} → ${repoRoot}`)
  } else {
    console.log("Marketplace already symlinked, skipping.")
  }

  console.log("\nDev mode enabled — hooks and skills now run from the local repo.")
  console.log("Hook changes take effect on the next invocation.")
  console.log("Skill changes require starting a new Claude Code session.")
}

function stop(): void {
  const cacheLinked = isSymlink(cachePath)
  const marketLinked = isSymlink(marketPath)

  if (!cacheLinked && !marketLinked) {
    console.log("Dev mode is not active — neither path is a symlink.")
    return
  }

  if (cacheLinked) {
    if (symlinkType) rmdirSync(cachePath)
    else rmSync(cachePath)
    if (existsSync(cacheBackup)) {
      renameSync(cacheBackup, cachePath)
      console.log(`Restored cache from backup: ${cachePath}`)
    } else {
      console.error(`No backup found at ${cacheBackup}`)
      console.error(`Reinstall the plugin: claude plugin install ${name}@${owner}`)
    }
  }

  if (marketLinked) {
    if (symlinkType) rmdirSync(marketPath)
    else rmSync(marketPath)
    if (existsSync(marketBackup)) {
      renameSync(marketBackup, marketPath)
      console.log(`Restored marketplace from backup: ${marketPath}`)
    } else {
      console.error(`No backup found at ${marketBackup}`)
      console.error(`Reinstall the plugin: claude plugin install ${name}@${owner}`)
    }
  }

  console.log(`\nDev mode disabled — hooks and skills now run from the cached release copy (v${version}).`)
}

const command = process.argv[2]

if (command === "start") {
  start()
} else if (command === "stop") {
  stop()
} else {
  console.error("Usage: bun scripts/dev-mode.ts <start|stop>")
  process.exit(1)
}
