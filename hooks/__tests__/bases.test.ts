import { describe, expect, it } from "bun:test"
import {
  type BasesIo,
  buildBaseDefinitions,
  shouldRunInitialBackfill,
  syncBases,
} from "../lib/bases.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"
import { durationSeconds } from "../lib/dates.ts"
import { normalizeModelId, parseModelContextCap } from "../lib/text.ts"
import type { Config } from "../lib/types.ts"

const baseConfig: Config = {
  ...DEFAULT_CONFIG,
  vault: "TestVault",
  bases: { enabled: true, path: "Claude/Bases" },
}

describe("buildBaseDefinitions", () => {
  it("produces the five managed base files under the configured path", () => {
    const defs = buildBaseDefinitions(baseConfig)
    expect(defs.map((d) => d.path)).toEqual([
      "Claude/Bases/claude-runs.base",
      "Claude/Bases/claude-plans.base",
      "Claude/Bases/claude-agents.base",
      "Claude/Bases/claude-sessions.base",
      "Claude/Bases/claude-journal.base",
    ])
  })

  it("parameterizes filters with the configured vault paths", () => {
    const config: Config = {
      ...baseConfig,
      plan: { path: "Custom/Plans", date_scheme: "calendar" },
      journal: { path: "Custom/Journal", date_scheme: "calendar" },
      session: { path: "Custom/Sessions" },
      bases: { enabled: true, path: "Custom/Bases" },
    }
    const defs = buildBaseDefinitions(config)
    const byName = new Map(defs.map((d) => [d.path.split("/").pop(), d.content]))
    expect(byName.get("claude-runs.base")).toContain('file.inFolder("Custom/Plans")')
    expect(byName.get("claude-plans.base")).toContain('file.inFolder("Custom/Plans")')
    expect(byName.get("claude-agents.base")).toContain('file.inFolder("Custom/Plans")')
    expect(byName.get("claude-sessions.base")).toContain('file.inFolder("Custom/Sessions")')
    expect(byName.get("claude-journal.base")).toContain('file.inFolder("Custom/Journal")')
    for (const path of defs.map((d) => d.path)) {
      expect(path.startsWith("Custom/Bases/")).toBe(true)
    }
  })

  it("stamps every base with the managed header", () => {
    for (const def of buildBaseDefinitions(baseConfig)) {
      expect(def.content.startsWith("# Managed by the capture-plan plugin")).toBe(true)
    }
  })

  it("excludes e2e-test artifacts from plan-tree bases", () => {
    const defs = buildBaseDefinitions(baseConfig)
    const planTree = defs.filter((d) => !/sessions|journal/.test(d.path))
    for (const def of planTree) {
      expect(def.content).toContain('file.path.contains("e2e-test")')
      expect(def.content).toContain('file.path.contains("test-project-")')
      expect(def.content).toContain('note.project == "test-project-1"')
    }
  })

  it("filters each doc type by its constant file name or marker property", () => {
    const defs = buildBaseDefinitions(baseConfig)
    const byName = new Map(defs.map((d) => [d.path.split("/").pop(), d.content]))
    expect(byName.get("claude-runs.base")).toContain('file.name == "tools-stats"')
    expect(byName.get("claude-plans.base")).toContain('file.name == "plan"')
    expect(byName.get("claude-agents.base")).toContain('file.hasProperty("subagent_type")')
  })
})

/** In-memory BasesIo for exercising syncBases without the Obsidian CLI. */
function memoryIo(initial: Record<string, string> = {}): BasesIo & {
  files: Record<string, string>
  writes: string[]
} {
  const files = { ...initial }
  const writes: string[] = []
  return {
    files,
    writes,
    read(pathRel) {
      return files[pathRel] ?? null
    },
    write(pathRel, content) {
      files[pathRel] = content
      writes.push(pathRel)
      return true
    },
  }
}

describe("syncBases", () => {
  it("creates all missing base files and reports them as net-new", () => {
    const io = memoryIo()
    const result = syncBases(baseConfig, undefined, io)
    expect(result.synced).toBe(true)
    expect(result.written.length).toBe(5)
    expect(result.created.length).toBe(5)
    expect(Object.keys(io.files).length).toBe(5)
  })

  it("reports replaced (drifted) files as written but not created", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    io.files["Claude/Bases/claude-runs.base"] = "tweaked"
    const result = syncBases(baseConfig, undefined, io)
    expect(result.written).toEqual(["Claude/Bases/claude-runs.base"])
    expect(result.created).toEqual([])
  })

  it("is idempotent — a second sync writes nothing", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    io.writes.length = 0
    const result = syncBases(baseConfig, undefined, io)
    expect(result.synced).toBe(true)
    expect(result.written).toEqual([])
    expect(io.writes).toEqual([])
  })

  it("authoritatively replaces manually modified base files", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    io.files["Claude/Bases/claude-runs.base"] = "views:\n  - type: table\n    name: My tweak\n"
    const result = syncBases(baseConfig, undefined, io)
    expect(result.written).toEqual(["Claude/Bases/claude-runs.base"])
    expect(io.files["Claude/Bases/claude-runs.base"]).toContain("# Managed by the capture-plan")
  })

  it("tolerates trailing whitespace differences without rewriting", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    const path = "Claude/Bases/claude-journal.base"
    io.files[path] = `${io.files[path].trim()}\n\n`
    const result = syncBases(baseConfig, undefined, io)
    expect(result.written).toEqual([])
  })

  it("does nothing when bases are disabled", () => {
    const io = memoryIo()
    const config: Config = { ...baseConfig, bases: { enabled: false, path: "Claude/Bases" } }
    const result = syncBases(config, undefined, io)
    expect(result.synced).toBe(false)
    expect(result.written).toEqual([])
    expect(Object.keys(io.files)).toEqual([])
  })

  it("reports failed writes without aborting the remaining files", () => {
    const io = memoryIo()
    const failing: BasesIo = {
      read: io.read,
      write(pathRel, content) {
        if (pathRel.includes("claude-runs")) return false
        return io.write(pathRel, content)
      },
    }
    const result = syncBases(baseConfig, undefined, failing)
    expect(result.synced).toBe(true)
    expect(result.written.length).toBe(4)
    expect(io.files["Claude/Bases/claude-runs.base"]).toBeUndefined()
  })
})

describe("shouldRunInitialBackfill", () => {
  it("triggers only when every managed base was created net-new", () => {
    const io = memoryIo()
    const firstRun = syncBases(baseConfig, undefined, io)
    expect(shouldRunInitialBackfill(firstRun, baseConfig)).toBe(true)
  })

  it("does not trigger when only some bases were recreated", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    delete io.files["Claude/Bases/claude-runs.base"]
    const partial = syncBases(baseConfig, undefined, io)
    expect(partial.created).toEqual(["Claude/Bases/claude-runs.base"])
    expect(shouldRunInitialBackfill(partial, baseConfig)).toBe(false)
  })

  it("does not trigger on a no-op or disabled sync", () => {
    const io = memoryIo()
    syncBases(baseConfig, undefined, io)
    expect(shouldRunInitialBackfill(syncBases(baseConfig, undefined, io), baseConfig)).toBe(false)
    const disabled: Config = { ...baseConfig, bases: { enabled: false, path: "Claude/Bases" } }
    expect(shouldRunInitialBackfill(syncBases(disabled, undefined, io), disabled)).toBe(false)
  })
})

describe("normalizeModelId", () => {
  it("strips payload-style context suffixes", () => {
    expect(normalizeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8")
    expect(normalizeModelId("claude-opus-4-6[200k]")).toBe("claude-opus-4-6")
  })

  it("strips legacy frontmatter-style suffixes", () => {
    expect(normalizeModelId("claude-opus-4-8 (1M)")).toBe("claude-opus-4-8")
    expect(normalizeModelId("claude-sonnet-4 (200K)")).toBe("claude-sonnet-4")
  })

  it("leaves bare model ids untouched", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8")
    expect(normalizeModelId("<synthetic>")).toBe("<synthetic>")
  })
})

describe("parseModelContextCap (lib)", () => {
  it("parses m and k suffixes", () => {
    expect(parseModelContextCap("claude-opus-4-6[1m]")).toBe(1_000_000)
    expect(parseModelContextCap("claude-opus-4-6[200K]")).toBe(200_000)
  })

  it("returns undefined without a suffix", () => {
    expect(parseModelContextCap("claude-opus-4-6")).toBeUndefined()
  })
})

describe("durationSeconds", () => {
  it("rounds milliseconds to whole seconds", () => {
    expect(durationSeconds(0)).toBe(0)
    expect(durationSeconds(11_000)).toBe(11)
    expect(durationSeconds(185_400)).toBe(185)
    expect(durationSeconds(500)).toBe(1)
  })
})
