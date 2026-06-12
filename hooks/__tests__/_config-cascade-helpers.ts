// _config-cascade-helpers.ts — Shared fixtures for config cascade tests
//
// Drives hooks/print-config.ts as a subprocess with synthesized layer fixtures
// so tests can assert effective value AND provenance for every config option.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfigWarning } from "../lib/types.ts"

export type { ConfigWarning }

/** A single configuration option together with sentinel values for cascade tests. */
export interface OptionSpec {
  /** Dotted key emitted by print-config (e.g. "plan.path"). */
  key: string
  /** TOML table name (e.g. "plan"); undefined for top-level keys. */
  table?: string
  /** TOML key inside the table (or top-level when table is omitted). */
  field: string
  /** Legacy flat alias key (e.g. "plan_path"), if any. */
  flatKey?: string
  /** Value print-config reports when no layer sets the option. */
  defaultValue: unknown
  /** Sentinel value attributed to the plugin layer. */
  pluginSample: unknown
  /** Sentinel value attributed to the user-global layer. */
  userSample: unknown
  /** Sentinel value attributed to the project-local layer. */
  projectSample: unknown
}

/**
 * Single source of truth for the config option matrix.
 * Mirrors KEYS in print-config.ts; the enumeration test fails loudly if KEYS drifts.
 */
export const EXPECTED_OPTIONS: OptionSpec[] = [
  {
    key: "vault",
    field: "vault",
    defaultValue: null,
    pluginSample: "plugin-vault",
    userSample: "user-vault",
    projectSample: "project-vault",
  },
  {
    key: "project_name",
    field: "project_name",
    defaultValue: null,
    pluginSample: "plugin-project",
    userSample: "user-project",
    projectSample: "project-project",
  },
  {
    key: "plan.path",
    table: "plan",
    field: "path",
    flatKey: "plan_path",
    defaultValue: "Claude/Plans",
    pluginSample: "plugin/plans",
    userSample: "user/plans",
    projectSample: "project/plans",
  },
  {
    key: "plan.date_scheme",
    table: "plan",
    field: "date_scheme",
    defaultValue: "calendar",
    pluginSample: "compact",
    userSample: "monthly",
    projectSample: "flat",
  },
  {
    key: "journal.path",
    table: "journal",
    field: "path",
    flatKey: "journal_path",
    defaultValue: "Claude/Journal",
    pluginSample: "plugin/journal",
    userSample: "user/journal",
    projectSample: "project/journal",
  },
  {
    key: "journal.date_scheme",
    table: "journal",
    field: "date_scheme",
    defaultValue: "calendar",
    pluginSample: "compact",
    userSample: "monthly",
    projectSample: "flat",
  },
  {
    key: "skills.path",
    table: "skills",
    field: "path",
    flatKey: "skills_path",
    defaultValue: "Claude/Skills",
    pluginSample: "plugin/skills",
    userSample: "user/skills",
    projectSample: "project/skills",
  },
  {
    key: "skills.date_scheme",
    table: "skills",
    field: "date_scheme",
    defaultValue: "calendar",
    pluginSample: "compact",
    userSample: "monthly",
    projectSample: "flat",
  },
  {
    key: "session.path",
    table: "session",
    field: "path",
    defaultValue: "Claude/Sessions",
    pluginSample: "plugin/sessions",
    userSample: "user/sessions",
    projectSample: "project/sessions",
  },
  {
    // session.enabled defaults to false. Use complementary sentinels so each layer's
    // value is distinct from the previous layer's: plugin=true, user=false, project=true.
    key: "session.enabled",
    table: "session",
    field: "enabled",
    defaultValue: false,
    pluginSample: true,
    userSample: false,
    projectSample: true,
  },
  {
    key: "session.prompt_max_chars",
    table: "session",
    field: "prompt_max_chars",
    defaultValue: null,
    pluginSample: 1000,
    userSample: 2000,
    projectSample: 3000,
  },
  {
    key: "context_cap",
    field: "context_cap",
    defaultValue: null,
    pluginSample: 100_000,
    userSample: 200_000,
    projectSample: 300_000,
  },
  {
    key: "superpowers_spec_pattern",
    field: "superpowers_spec_pattern",
    defaultValue: null,
    pluginSample: "/plugin-spec/",
    userSample: "/user-spec/",
    projectSample: "/project-spec/",
  },
  {
    key: "superpowers_plan_pattern",
    field: "superpowers_plan_pattern",
    defaultValue: null,
    pluginSample: "/plugin-plan/",
    userSample: "/user-plan/",
    projectSample: "/project-plan/",
  },
  {
    key: "capture_skills",
    field: "capture_skills",
    defaultValue: ["simplify"],
    pluginSample: ["plugin-skill"],
    userSample: ["user-skill"],
    projectSample: ["project-skill"],
  },
]

/** Render a TOML literal for a single value (string, number, bool, or string array). */
function tomlLiteral(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(", ")}]`
  throw new Error(`tomlLiteral: unsupported value ${JSON.stringify(value)}`)
}

/** Render a one-key TOML snippet using the grouped table form when spec.table is set. */
export function tomlFor(spec: OptionSpec, value: unknown): string {
  const literal = tomlLiteral(value)
  if (spec.table) {
    return `[${spec.table}]\n${spec.field} = ${literal}\n`
  }
  return `${spec.field} = ${literal}\n`
}

/** Render a one-key TOML snippet using the legacy flat alias. Throws if the option has no flatKey. */
export function flatTomlFor(spec: OptionSpec, value: unknown): string {
  if (!spec.flatKey) {
    throw new Error(`flatTomlFor: option ${spec.key} has no flatKey`)
  }
  return `${spec.flatKey} = ${tomlLiteral(value)}\n`
}

/** Inputs to runPrintConfig — TOML strings for any layer under test. Omit to leave that layer absent. */
export interface CascadeFixture {
  pluginToml?: string
  userToml?: string
  projectToml?: string
}

/** Source attribution emitted by print-config for a single option. */
export type ConfigSource = "default" | "plugin" | "user" | "project"

/** A single option entry in the print-config JSON output. */
export interface PrintConfigOption {
  key: string
  value: unknown
  source: ConfigSource
}

/** Parsed print-config JSON output. */
export interface PrintConfigOutput {
  options: PrintConfigOption[]
  configPaths: {
    plugin: string
    user: string
    project: string | null
  }
  warnings?: ConfigWarning[]
}

const PRINT_CONFIG_SCRIPT = join(import.meta.dir, "..", "print-config.ts")

/**
 * Spawn print-config with synthesized layer fixtures and return its parsed output.
 * Each call uses isolated temp directories that are removed on completion.
 */
export async function runPrintConfig(fixture: CascadeFixture): Promise<PrintConfigOutput> {
  const pluginDir = mkdtempSync(join(tmpdir(), "cap-plugin-"))
  const userDir = mkdtempSync(join(tmpdir(), "cap-user-"))
  const projectDir = mkdtempSync(join(tmpdir(), "cap-project-"))

  try {
    if (fixture.pluginToml !== undefined) {
      writeFileSync(join(pluginDir, "capture-plan.toml"), fixture.pluginToml, "utf8")
    }
    if (fixture.userToml !== undefined) {
      const userConfigDir = join(userDir, "capture-plan")
      mkdirSync(userConfigDir, { recursive: true })
      writeFileSync(join(userConfigDir, "config.toml"), fixture.userToml, "utf8")
    }
    if (fixture.projectToml !== undefined) {
      const claudeDir = join(projectDir, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, "capture-plan.toml"), fixture.projectToml, "utf8")
    }

    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginDir,
      CLAUDE_CWD: projectDir,
    }
    if (process.platform === "win32") {
      env.LOCALAPPDATA = userDir
    } else {
      env.HOME = userDir
    }

    const proc = Bun.spawn([Bun.argv[0], "run", PRINT_CONFIG_SCRIPT], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new Error(`print-config exited ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
    }
    return JSON.parse(stdout) as PrintConfigOutput
  } finally {
    rmSync(pluginDir, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
}

/** Look up an option in print-config output; throws a clear error if missing. */
export function findOption(options: PrintConfigOption[], key: string): PrintConfigOption {
  const match = options.find((o) => o.key === key)
  if (!match) {
    const known = options.map((o) => o.key).join(", ")
    throw new Error(`Option "${key}" not found in print-config output. Known: ${known}`)
  }
  return match
}
