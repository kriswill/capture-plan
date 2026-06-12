import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeConfigDir,
  DEFAULT_CONFIG,
  findTranscriptPath,
  getUserConfigDir,
  loadConfig,
  projectSlug,
  userGlobalConfigPath,
} from "../lib/config.ts"

/** Save an env var in beforeEach and restore it in afterEach, so a failing
 *  assertion mid-test can't leak mutated env state into later tests. */
function preserveEnv(name: string): void {
  let original: string | undefined
  beforeEach(() => {
    original = process.env[name]
  })
  afterEach(() => {
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  })
}

describe("claudeConfigDir", () => {
  preserveEnv("CLAUDE_CONFIG_DIR")

  it("returns CLAUDE_CONFIG_DIR when set", () => {
    process.env.CLAUDE_CONFIG_DIR = "/Users/testuser/.claude-work"
    expect(claudeConfigDir()).toBe("/Users/testuser/.claude-work")
  })

  it("trims surrounding whitespace from CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = " /Users/testuser/.claude-work "
    expect(claudeConfigDir()).toBe("/Users/testuser/.claude-work")
  })

  it("falls back to ~/.claude when unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude"))
  })

  it("falls back to ~/.claude when set to an empty or blank string", () => {
    process.env.CLAUDE_CONFIG_DIR = "  "
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude"))
  })
})

describe("getUserConfigDir", () => {
  preserveEnv("LOCALAPPDATA")

  it("returns LOCALAPPDATA path on win32 when LOCALAPPDATA is set", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\testuser\\AppData\\Local"
    expect(getUserConfigDir("win32")).toBe(
      join("C:\\Users\\testuser\\AppData\\Local", "capture-plan"),
    )
  })

  it("returns AppData\\Local fallback on win32 when LOCALAPPDATA is unset", () => {
    delete process.env.LOCALAPPDATA
    expect(getUserConfigDir("win32")).toBe(join(homedir(), "AppData", "Local", "capture-plan"))
  })

  it("returns ~/.config/capture-plan on non-Windows", () => {
    const result = getUserConfigDir("linux")
    expect(result).toBe(join(homedir(), ".config", "capture-plan"))
  })
})

describe("userGlobalConfigPath", () => {
  it("appends config.toml to getUserConfigDir()", () => {
    const configDir = getUserConfigDir()
    expect(userGlobalConfigPath()).toBe(join(configDir, "config.toml"))
  })
})

describe("findTranscriptPath", () => {
  it("returns null when cwd is not provided", () => {
    const result = findTranscriptPath("session-123")
    expect(result).toBeNull()
  })

  it("handles forward slashes in cwd path", () => {
    expect(projectSlug("/home/user/projects/my-project")).toBe("--home-user-projects-my-project")
  })

  it("handles backslashes in cwd path (Windows)", () => {
    expect(projectSlug("C:\\Users\\testuser\\projects\\my-project")).toBe(
      "-C-Users-testuser-projects-my-project",
    )
  })

  it("removes drive letter colon on Windows paths", () => {
    const slug = projectSlug("C:\\Users\\testuser\\projects")
    expect(slug).toBe("-C-Users-testuser-projects")
    expect(slug.includes(":")).toBe(false)
  })

  it("handles mixed separators", () => {
    expect(projectSlug("C:\\Users/testuser\\projects/my-project")).toBe(
      "-C-Users-testuser-projects-my-project",
    )
  })
})

describe("loadConfig project_name", () => {
  function writeProjectToml(contents: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "cp-project-name-"))
    mkdirSync(join(cwd, ".claude"), { recursive: true })
    writeFileSync(join(cwd, ".claude", "capture-plan.toml"), contents)
    return cwd
  }

  it("resolves project_name from project-local TOML", async () => {
    const cwd = writeProjectToml('project_name = "my-custom-project"\n')
    try {
      const config = await loadConfig(cwd)
      expect(config.project_name).toBe("my-custom-project")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("trims whitespace from project_name", async () => {
    const cwd = writeProjectToml('project_name = "  padded  "\n')
    try {
      const config = await loadConfig(cwd)
      expect(config.project_name).toBe("padded")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("falls back to undefined when project_name is an empty string", async () => {
    const cwd = writeProjectToml('project_name = ""\n')
    try {
      const config = await loadConfig(cwd)
      expect(config.project_name).toBeUndefined()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("CONFIG_DEBUG_LOG path", () => {
  it("uses platform-aware temp directory, not hardcoded /tmp", async () => {
    // CONFIG_DEBUG_LOG is module-private, so check the source directly:
    // the debug log path must be built with tmpdir(), never a hardcoded /tmp prefix.
    // (tmpdir() itself may legitimately return "/tmp" on Linux.)
    const source = await Bun.file(join(import.meta.dir, "..", "lib", "config.ts")).text()
    const definition = source.split("\n").find((line) => line.includes("CONFIG_DEBUG_LOG ="))
    expect(definition).toBeDefined()
    expect(definition).toContain("tmpdir()")
    expect(definition).not.toContain('"/tmp')
  })
})

describe("DEFAULT_CONFIG skills field", () => {
  it("has path 'Claude/Skills'", () => {
    expect(DEFAULT_CONFIG.skills.path).toBe("Claude/Skills")
  })

  it("has date_scheme 'calendar'", () => {
    expect(DEFAULT_CONFIG.skills.date_scheme).toBe("calendar")
  })
})

function makeProjectDir(suffix: string, toml: string): string {
  const dir = join(tmpdir(), `capture-plan-test-${Date.now()}-${suffix}`)
  const claudeDir = join(dir, ".claude")
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, "capture-plan.toml"), toml, "utf8")
  return dir
}

describe("loadConfig – skills resolution", () => {
  it("uses explicit [skills].path from project TOML", async () => {
    const dir = makeProjectDir(
      "skills-path",
      '[skills]\npath = "Custom/Activity"\ndate_scheme = "calendar"\n',
    )
    const config = await loadConfig(dir)
    expect(config.skills.path).toBe("Custom/Activity")
  })

  it("uses explicit [skills].date_scheme over inherited plan scheme", async () => {
    const dir = makeProjectDir(
      "skills-scheme-wins",
      '[plan]\ndate_scheme = "compact"\n[skills]\npath = "Custom/Activity"\ndate_scheme = "flat"\n',
    )
    const config = await loadConfig(dir)
    expect(config.skills.date_scheme).toBe("flat")
    expect(config.plan.date_scheme).toBe("compact")
  })

  it("inherits plan date_scheme when [skills] omits date_scheme", async () => {
    const dir = makeProjectDir(
      "skills-inherits-plan",
      '[plan]\ndate_scheme = "compact"\n[skills]\npath = "Custom/Activity"\n',
    )
    const config = await loadConfig(dir)
    expect(config.skills.date_scheme).toBe("compact")
  })

  it("inherits calendar when plan date_scheme is calendar and [skills] omits date_scheme", async () => {
    const dir = makeProjectDir(
      "skills-inherits-calendar",
      '[plan]\ndate_scheme = "calendar"\n[skills]\npath = "Custom/Activity"\n',
    )
    const config = await loadConfig(dir)
    expect(config.skills.date_scheme).toBe("calendar")
  })

  it("capture_skills nested under [skills] table is read correctly", async () => {
    const dir = makeProjectDir(
      "capture-skills-nested",
      'vault = "Test"\n[plan]\npath = "X"\n[skills]\npath = "Y"\ncapture_skills = ["simplify", "code-review"]\n',
    )
    const config = await loadConfig(dir)
    expect(config.capture_skills).toEqual(["simplify", "code-review"])
  })

  it("capture_skills appearing after [plan] table is still recovered", async () => {
    const dir = makeProjectDir(
      "capture-skills-after-plan",
      'vault = "T"\n[plan]\npath = "X"\ncapture_skills = ["test-only-skill-plan"]\n',
    )
    const config = await loadConfig(dir)
    expect(config.capture_skills).toEqual(["test-only-skill-plan"])
  })

  it("capture_skills appearing after [journal] table is still recovered", async () => {
    // Mirrors the actual main-win bug: key placed after [journal] gets scoped as journal.capture_skills
    const dir = makeProjectDir(
      "capture-skills-after-journal",
      'vault = "T"\n[plan]\npath = "X"\n[journal]\npath = "Y"\ncapture_skills = ["test-only-skill-journal","code-review"]\n',
    )
    const config = await loadConfig(dir)
    expect(config.capture_skills).toEqual(["test-only-skill-journal", "code-review"])
  })

  it("capture_skills appearing after [session] table is still recovered", async () => {
    const dir = makeProjectDir(
      "capture-skills-after-session",
      'vault = "T"\n[session]\nenabled = true\ncapture_skills = ["test-only-skill-session"]\n',
    )
    const config = await loadConfig(dir)
    expect(config.capture_skills).toEqual(["test-only-skill-session"])
  })

  it("falls back to calendar (not plan's scheme) when [skills].date_scheme is invalid", async () => {
    // resolveScheme("not-a-valid-scheme") returns "calendar" — the hardcoded default,
    // NOT the plan's scheme ("monthly"). This is intentional: invalid values are
    // treated as if the key were absent, but the fallback is always "calendar",
    // not the inherited plan scheme.
    const dir = makeProjectDir(
      "skills-invalid-scheme",
      '[plan]\ndate_scheme = "monthly"\n[skills]\npath = "Custom/Activity"\ndate_scheme = "not-a-valid-scheme"\n',
    )
    const config = await loadConfig(dir)
    expect(config.skills.date_scheme).toBe("calendar")
  })
})

describe("loadConfig – stray top-level scalar recovery", () => {
  it("vault key placed under [journal] is still recovered as top-level", async () => {
    const dir = makeProjectDir("stray-vault", '[journal]\npath = "J"\nvault = "VaultX"\n')
    const config = await loadConfig(dir)
    expect(config.vault).toBe("VaultX")
  })

  it("context_cap key placed under [journal] is still recovered as top-level", async () => {
    const dir = makeProjectDir(
      "stray-context-cap",
      'vault = "T"\n[journal]\npath = "J"\ncontext_cap = 500000\n',
    )
    const config = await loadConfig(dir)
    expect(config.context_cap).toBe(500000)
  })

  it("superpowers_spec_pattern key placed under [journal] is still recovered as top-level", async () => {
    const dir = makeProjectDir(
      "stray-spec-pattern",
      'vault = "T"\n[journal]\npath = "J"\nsuperpowers_spec_pattern = "/sp-specs/"\n',
    )
    const config = await loadConfig(dir)
    expect(config.superpowers_spec_pattern).toBe("/sp-specs/")
  })

  it("superpowers_plan_pattern key placed under [journal] is still recovered as top-level", async () => {
    const dir = makeProjectDir(
      "stray-plan-pattern",
      'vault = "T"\n[journal]\npath = "J"\nsuperpowers_plan_pattern = "/sp-plans/"\n',
    )
    const config = await loadConfig(dir)
    expect(config.superpowers_plan_pattern).toBe("/sp-plans/")
  })
})
