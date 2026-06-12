#!/usr/bin/env bun
// print-config.ts — Print full plugin configuration with per-option provenance

import { join } from "node:path"
import { getUserConfigDir, recoverStrayKeysFromLayer } from "./lib/config.ts"
import { type ConfigLayer, type ConfigWarning, PLUGIN_ROOT } from "./lib/types.ts"
import { loadToml } from "./shared.ts"

type Layer = Record<string, unknown> | null

interface ConfigEntry {
  key: string
  value: unknown
  source: "default" | ConfigLayer
}

/** Extract a value from a raw TOML layer, checking grouped table then flat legacy key. */
function extract(layer: Layer, table: string | undefined, key: string, flatKey?: string): unknown {
  if (!layer) return undefined
  if (table) {
    const section = layer[table] as Record<string, unknown> | undefined
    if (section?.[key] !== undefined) return section[key]
  }
  if (flatKey && layer[flatKey] !== undefined) return layer[flatKey]
  if (!table && layer[key] !== undefined) return layer[key]
  return undefined
}

interface KeyDef {
  key: string
  table?: string
  field: string
  flatKey?: string
  defaultValue: unknown
}

const KEYS: KeyDef[] = [
  { key: "vault", field: "vault", defaultValue: null },
  { key: "project_name", field: "project_name", defaultValue: null },
  {
    key: "plan.path",
    table: "plan",
    field: "path",
    flatKey: "plan_path",
    defaultValue: "Claude/Plans",
  },
  { key: "plan.date_scheme", table: "plan", field: "date_scheme", defaultValue: "calendar" },
  {
    key: "journal.path",
    table: "journal",
    field: "path",
    flatKey: "journal_path",
    defaultValue: "Claude/Journal",
  },
  { key: "journal.date_scheme", table: "journal", field: "date_scheme", defaultValue: "calendar" },
  {
    key: "skills.path",
    table: "skills",
    field: "path",
    flatKey: "skills_path",
    defaultValue: "Claude/Skills",
  },
  { key: "skills.date_scheme", table: "skills", field: "date_scheme", defaultValue: "calendar" },
  { key: "session.path", table: "session", field: "path", defaultValue: "Claude/Sessions" },
  { key: "session.enabled", table: "session", field: "enabled", defaultValue: false },
  {
    key: "session.prompt_max_chars",
    table: "session",
    field: "prompt_max_chars",
    defaultValue: null,
  },
  { key: "context_cap", field: "context_cap", defaultValue: null },
  { key: "superpowers_spec_pattern", field: "superpowers_spec_pattern", defaultValue: null },
  { key: "superpowers_plan_pattern", field: "superpowers_plan_pattern", defaultValue: null },
  { key: "capture_skills", field: "capture_skills", defaultValue: ["simplify"] },
]

const cwd = process.env.CLAUDE_CWD

const pluginPath = join(PLUGIN_ROOT, "capture-plan.toml")
const userPath = join(getUserConfigDir(), "config.toml")
const projectPath = cwd ? join(cwd, ".claude", "capture-plan.toml") : null

const rawPluginLayer = await loadToml(pluginPath)
const rawUserLayer = await loadToml(userPath)
const rawProjectLayer = projectPath ? await loadToml(projectPath) : null

const pluginR = recoverStrayKeysFromLayer(rawPluginLayer, "plugin")
const userR = recoverStrayKeysFromLayer(rawUserLayer, "user")
const projectR = recoverStrayKeysFromLayer(rawProjectLayer, "project")
const warnings: ConfigWarning[] = [...pluginR.warnings, ...userR.warnings, ...projectR.warnings]

const layers: Array<{ name: ConfigLayer; data: Layer }> = [
  { name: "plugin", data: pluginR.recovered },
  { name: "user", data: userR.recovered },
  { name: "project", data: projectR.recovered },
]

const options: ConfigEntry[] = KEYS.map(({ key, table, field, flatKey, defaultValue }) => {
  let value: unknown = defaultValue
  let source: ConfigEntry["source"] = "default"

  for (const layer of layers) {
    const v = extract(layer.data, table, field, flatKey)
    if (v !== undefined && v !== null) {
      value = v
      source = layer.name
    }
  }

  return { key, value, source }
})

console.log(
  JSON.stringify({
    options,
    configPaths: {
      plugin: pluginPath,
      user: userPath,
      project: projectPath || null,
    },
    warnings,
  }),
)
