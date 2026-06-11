import { describe, expect, it } from "bun:test"
import {
  computeContextPct,
  contextCapLabel,
  formatCcVersionYaml,
  formatModelYaml,
  formatStatsYaml,
  formatToolTable,
  mergeTranscriptStats,
  parsePlanFrontmatter,
  resolveContextCap,
} from "../shared.ts"
import type { TranscriptStats } from "../transcript.ts"

describe("parsePlanFrontmatter", () => {
  it("parses new-format frontmatter (topical tags, project, session link)", () => {
    const content = `---
created: "[[Journal/2026/03-March/29-Sunday|2026-03-29T14:30]]"
project: capture-plan
tags:
  - plugin-dev
  - hooks
session: "[[Sessions/3a76e3ac]]"
---
# My Plan

Body text`

    const fm = parsePlanFrontmatter(content)
    expect(fm.created).toBe("[[Journal/2026/03-March/29-Sunday|2026-03-29T14:30]]")
    expect(fm.journalPath).toBe("Journal/2026/03-March/29-Sunday")
    expect(fm.datetime).toBe("2026-03-29T14:30")
    expect(fm.project).toBe("capture-plan")
    expect(fm.tags).toEqual(["plugin-dev", "hooks"])
    expect(fm.session).toBe('"[[Sessions/3a76e3ac]]"')
  })

  it("parses legacy frontmatter (status, counter, source)", () => {
    const content = `---
created: "[[Journal/2026/03-March/29-Sunday|2026-03-29T14:30]]"
status: planned
tags:
  - plan
  - claude-session
source: Claude Code (Plan Mode)
session: abc123
counter: 1
---
# My Plan

Body text`

    const fm = parsePlanFrontmatter(content)
    expect(fm.created).toBe("[[Journal/2026/03-March/29-Sunday|2026-03-29T14:30]]")
    expect(fm.status).toBe("planned")
    expect(fm.tags).toEqual(["plan", "claude-session"])
    expect(fm.session).toBe("abc123")
    expect(fm.counter).toBe(1)
  })

  it("returns empty object when no frontmatter", () => {
    const fm = parsePlanFrontmatter("# Just a heading\n\nSome text")
    expect(fm).toEqual({})
  })

  it("handles frontmatter without created field", () => {
    const content = `---
status: planned
counter: 5
---
# Plan`

    const fm = parsePlanFrontmatter(content)
    expect(fm.created).toBeUndefined()
    expect(fm.journalPath).toBeUndefined()
    expect(fm.datetime).toBeUndefined()
    expect(fm.status).toBe("planned")
    expect(fm.counter).toBe(5)
  })

  it("handles frontmatter without tags", () => {
    const content = `---
status: done
---
# Plan`

    const fm = parsePlanFrontmatter(content)
    expect(fm.tags).toBeUndefined()
    expect(fm.status).toBe("done")
  })

  it("handles created field without quotes", () => {
    const content = `---
created: [[Journal/2026/01-January/15-Wednesday|2026-01-15T09:00]]
---
# Plan`

    const fm = parsePlanFrontmatter(content)
    expect(fm.journalPath).toBe("Journal/2026/01-January/15-Wednesday")
    expect(fm.datetime).toBe("2026-01-15T09:00")
  })

  it("parses project field", () => {
    const content = `---
project: my-app
---
# Plan`

    const fm = parsePlanFrontmatter(content)
    expect(fm.project).toBe("my-app")
  })

  it("handles empty content", () => {
    expect(parsePlanFrontmatter("")).toEqual({})
  })

  it("handles malformed frontmatter (no closing ---)", () => {
    const content = `---
status: planned
# No closing delimiter`

    expect(parsePlanFrontmatter(content)).toEqual({})
  })
})

describe("contextCapLabel", () => {
  it("formats 200K", () => {
    expect(contextCapLabel(200_000)).toBe("200K")
  })

  it("formats 1M", () => {
    expect(contextCapLabel(1_000_000)).toBe("1M")
  })

  it("formats 2M", () => {
    expect(contextCapLabel(2_000_000)).toBe("2M")
  })

  it("formats 500K", () => {
    expect(contextCapLabel(500_000)).toBe("500K")
  })

  it("rounds to nearest K", () => {
    expect(contextCapLabel(128_000)).toBe("128K")
  })
})

describe("resolveContextCap", () => {
  it("returns config value when provided", () => {
    expect(resolveContextCap(50000, 1_000_000)).toBe(1_000_000)
  })

  it("auto-detects 1M when peak > 200K", () => {
    expect(resolveContextCap(250_000)).toBe(1_000_000)
  })

  it("defaults to 200K when peak is within standard range", () => {
    expect(resolveContextCap(100_000)).toBe(200_000)
  })

  it("config takes priority over auto-detect", () => {
    expect(resolveContextCap(250_000, 500_000)).toBe(500_000)
  })
})

describe("computeContextPct", () => {
  it("computes percentage from input + output", () => {
    const tokens = { input: 50_000, output: 10_000, cache_read: 0, cache_create: 0 }
    expect(computeContextPct(tokens, 200_000)).toBe(30)
  })

  it("rounds to nearest integer", () => {
    const tokens = { input: 33_333, output: 0, cache_read: 0, cache_create: 0 }
    expect(computeContextPct(tokens, 200_000)).toBe(17)
  })

  it("returns 0 when cap is 0", () => {
    const tokens = { input: 50_000, output: 10_000, cache_read: 0, cache_create: 0 }
    expect(computeContextPct(tokens, 0)).toBe(0)
  })

  it("handles large context windows", () => {
    const tokens = { input: 100_000, output: 50_000, cache_read: 0, cache_create: 0 }
    expect(computeContextPct(tokens, 1_000_000)).toBe(15)
  })
})

describe("formatStatsYaml", () => {
  const baseStats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 300_000,
    tokens: { input: 12500, output: 3200, cache_read: 8000, cache_create: 1500 },
    peakTurnContext: 15000,
    subagentCount: 2,
    tools: [
      { name: "Read", calls: 5, errors: 0 },
      { name: "Edit", calls: 3, errors: 1 },
    ],
    mcpServers: [{ name: "context-mode", tools: ["ctx_search"], calls: 2 }],
    totalToolCalls: 10,
    totalErrors: 1,
  }

  it("formats all stats fields including context", () => {
    const yaml = formatStatsYaml(baseStats)
    expect(yaml).toContain("model: claude-opus-4-6")
    expect(yaml).toContain("context_window: 200000")
    expect(yaml).toContain('duration: "5m"')
    expect(yaml).toContain("duration_s: 300")
    expect(yaml).toContain("tokens_in: 12500")
    expect(yaml).toContain("tokens_out: 3200")
    expect(yaml).toContain("context_pct:")
    expect(yaml).toContain("subagents: 2")
    expect(yaml).toContain("tools_used: 10")
    expect(yaml).toContain("total_errors: 1")
    expect(yaml).toContain("mcp_servers:")
    expect(yaml).toContain("  - context-mode")
  })

  it("uses explicit contextCap when provided", () => {
    const yaml = formatStatsYaml(baseStats, 1_000_000)
    expect(yaml).toContain("model: claude-opus-4-6")
    expect(yaml).toContain("context_window: 1000000")
  })

  it("omits mcp_servers when empty", () => {
    const stats = { ...baseStats, mcpServers: [] }
    const yaml = formatStatsYaml(stats)
    expect(yaml).not.toContain("mcp_servers:")
  })

  it("handles zero tokens", () => {
    const stats = {
      ...baseStats,
      tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    }
    const yaml = formatStatsYaml(stats)
    expect(yaml).toContain("tokens_in: 0")
    expect(yaml).toContain("tokens_out: 0")
    expect(yaml).toContain("context_pct: 0")
  })
})

describe("formatModelYaml", () => {
  const stats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 0,
    tokens: { input: 50000, output: 10000, cache_read: 0, cache_create: 0 },
    peakTurnContext: 50000,
    subagentCount: 0,
    tools: [],
    mcpServers: [],
    totalToolCalls: 0,
    totalErrors: 0,
  }

  it("returns normalized model with context_window and context_pct", () => {
    const yaml = formatModelYaml(stats)
    expect(yaml).toContain("model: claude-opus-4-6")
    expect(yaml).toContain("context_window: 200000")
    expect(yaml).toContain("context_pct: 30") // (50000+10000)/200000 = 30%
  })

  it("uses explicit contextCap when provided", () => {
    const yaml = formatModelYaml(stats, 1_000_000)
    expect(yaml).toContain("model: claude-opus-4-6")
    expect(yaml).toContain("context_window: 1000000")
    expect(yaml).toContain("context_pct: 6") // (50000+10000)/1000000 = 6%
  })

  it("returns empty string for null", () => {
    expect(formatModelYaml(null)).toBe("")
  })
})

describe("formatCcVersionYaml", () => {
  it("returns cc_version line with newline prefix", () => {
    expect(formatCcVersionYaml("v2.1.89")).toBe('\ncc_version: "v2.1.89"')
  })

  it("returns empty string for undefined", () => {
    expect(formatCcVersionYaml(undefined)).toBe("")
  })

  it("returns empty string for empty string", () => {
    expect(formatCcVersionYaml("")).toBe("")
  })
})

describe("formatToolTable", () => {
  it("renders markdown table rows", () => {
    const tools = [
      { name: "Read", calls: 5, errors: 0 },
      { name: "Bash", calls: 3, errors: 1 },
    ]
    const table = formatToolTable(tools)
    expect(table).toContain("| Tool | Calls | Errors |")
    expect(table).toContain("|------|------:|-------:|")
    expect(table).toContain("| Read | 5 | 0 |")
    expect(table).toContain("| Bash | 3 | 1 |")
  })

  it("returns empty string when no tools", () => {
    expect(formatToolTable([])).toBe("")
  })
})

describe("mergeTranscriptStats", () => {
  const planStats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 60_000,
    tokens: { input: 5000, output: 1000, cache_read: 3000, cache_create: 500 },
    peakTurnContext: 8000,
    subagentCount: 1,
    tools: [
      { name: "Read", calls: 5, errors: 0 },
      { name: "Grep", calls: 2, errors: 0 },
    ],
    mcpServers: [{ name: "context-mode", tools: ["ctx_search"], calls: 1 }],
    totalToolCalls: 7,
    totalErrors: 0,
  }

  const execStats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 120_000,
    tokens: { input: 10000, output: 4000, cache_read: 7000, cache_create: 1000 },
    peakTurnContext: 15000,
    subagentCount: 2,
    tools: [
      { name: "Read", calls: 3, errors: 0 },
      { name: "Edit", calls: 8, errors: 1 },
      { name: "Bash", calls: 4, errors: 2 },
    ],
    mcpServers: [{ name: "context-mode", tools: ["ctx_execute"], calls: 3 }],
    totalToolCalls: 15,
    totalErrors: 3,
  }

  it("sums tokens across phases", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    expect(merged.tokens.input).toBe(15000)
    expect(merged.tokens.output).toBe(5000)
    expect(merged.tokens.cache_read).toBe(10000)
    expect(merged.tokens.cache_create).toBe(1500)
  })

  it("sums tool calls for same-named tools", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    const readTool = merged.tools.find((t) => t.name === "Read")
    expect(readTool?.calls).toBe(8)
    expect(readTool?.errors).toBe(0)
  })

  it("preserves unique tools from each phase", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    expect(merged.tools.find((t) => t.name === "Grep")).toBeDefined()
    expect(merged.tools.find((t) => t.name === "Edit")).toBeDefined()
    expect(merged.tools.find((t) => t.name === "Bash")).toBeDefined()
  })

  it("sums totals", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    expect(merged.totalToolCalls).toBe(22)
    expect(merged.totalErrors).toBe(3)
    expect(merged.subagentCount).toBe(3)
    expect(merged.durationMs).toBe(180_000)
  })

  it("merges MCP servers and unions tools", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    const srv = merged.mcpServers.find((s) => s.name === "context-mode")
    expect(srv).toBeDefined()
    expect(srv?.calls).toBe(4)
    expect(srv?.tools).toContain("ctx_search")
    expect(srv?.tools).toContain("ctx_execute")
  })

  it("picks non-unknown model", () => {
    const aUnknown = { ...planStats, model: "unknown" }
    const merged = mergeTranscriptStats(aUnknown, execStats)
    expect(merged.model).toBe("claude-opus-4-6")
  })

  it("takes max of peakTurnContext", () => {
    const merged = mergeTranscriptStats(planStats, execStats)
    expect(merged.peakTurnContext).toBe(15000)
  })
})
