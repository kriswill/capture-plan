import { describe, expect, it } from "bun:test"
import { formatToolsNoteContent } from "../shared.ts"
import type { TranscriptStats } from "../transcript.ts"

describe("formatToolsNoteContent", () => {
  const baseOpts = {
    planTitle: "My Plan",
    planDir: "Claude/Plans/2026/03-30/001-my-plan",
    journalPath: "Journal/2026/03-March/30-Monday",
    datetime: "2026-03-30T14:30",
  }

  const planStats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 60_000,
    tokens: { input: 5000, output: 1000, cache_read: 0, cache_create: 0 },
    peakTurnContext: 5000,
    subagentCount: 0,
    tools: [{ name: "Read", calls: 3, errors: 0 }],
    mcpServers: [],
    totalToolCalls: 3,
    totalErrors: 0,
  }

  const execStats: TranscriptStats = {
    model: "claude-opus-4-6",
    durationMs: 120_000,
    tokens: { input: 10000, output: 4000, cache_read: 0, cache_create: 0 },
    peakTurnContext: 10000,
    subagentCount: 1,
    tools: [
      { name: "Edit", calls: 5, errors: 1 },
      { name: "Bash", calls: 3, errors: 0 },
    ],
    mcpServers: [],
    totalToolCalls: 8,
    totalErrors: 1,
  }

  it("returns null when both phases are null", () => {
    expect(formatToolsNoteContent({ ...baseOpts, planStats: null, execStats: null })).toBeNull()
  })

  it("includes frontmatter with combined stats", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats,
    })
    expect(content).toContain("tools_used: 11")
    expect(content).toContain("total_errors: 1")
    expect(content).toContain("tokens_in: 15000")
    expect(content).toContain("tokens_out: 5000")
  })

  it("includes plan backlink in frontmatter", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
    })
    expect(content).toContain('plan: "[[Claude/Plans/2026/03-30/001-my-plan/plan|My Plan]]"')
  })

  it("renders both phase tables", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats,
    })
    expect(content).toContain("## Planning Phase")
    expect(content).toContain("## Execution Phase")
    expect(content).toContain("## Combined")
  })

  it("renders only planning phase when no execution", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
    })
    expect(content).toContain("## Planning Phase")
    expect(content).not.toContain("## Execution Phase")
  })

  it("renders only execution phase when no planning stats", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats: null,
      execStats,
    })
    expect(content).not.toContain("## Planning Phase")
    expect(content).toContain("## Execution Phase")
  })

  it("includes project in frontmatter when provided", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
      project: "capture-plan",
    })
    expect(content).toContain("project: capture-plan")
  })

  it("includes title in heading", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
    })
    expect(content).toContain("# Session Tools: My Plan")
  })

  it("includes context usage line in Combined section", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats,
    })
    // Combined: (15000+5000) / 200000 = 10%
    expect(content).toContain("**Context:")
    expect(content).toContain("(10%)")
  })

  it("uses explicit contextCap when provided", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats,
      contextCap: 1_000_000,
    })
    expect(content).toContain("model: claude-opus-4-6")
    expect(content).toContain("context_window: 1000000")
  })

  it("includes cc_version in frontmatter when provided", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
      ccVersion: "v2.1.89",
    })
    expect(content).toContain('cc_version: "v2.1.89"')
  })

  it("omits cc_version when not provided", () => {
    const content = formatToolsNoteContent({
      ...baseOpts,
      planStats,
      execStats: null,
    })
    expect(content).not.toContain("cc_version")
  })
})
