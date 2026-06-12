import { describe, expect, it } from "bun:test"
import {
  type BackfillPaths,
  classifyDoc,
  deriveDate,
  parseDurationToSeconds,
  parseModelContextWindow,
  upgradeNoteContent,
} from "../lib/backfill.ts"

const paths: BackfillPaths = {
  planPath: "Claude/Plans",
  journalPath: "Claude/Journal",
  sessionPath: "Claude/Sessions",
}

describe("classifyDoc", () => {
  it("classifies known plan-tree basenames", () => {
    const dir = "Claude/Plans/2026/06-June/10-Wednesday/001-slug"
    expect(classifyDoc(`${dir}/plan.md`, paths)).toBe("plan")
    expect(classifyDoc(`${dir}/summary.md`, paths)).toBe("summary")
    expect(classifyDoc(`${dir}/tools-stats.md`, paths)).toBe("tools-stats")
    expect(classifyDoc(`${dir}/tools-log.md`, paths)).toBe("tools-log")
    expect(classifyDoc(`${dir}/activity.md`, paths)).toBe("activity")
    expect(classifyDoc(`${dir}/spec.md`, paths)).toBe("spec")
    expect(classifyDoc(`${dir}/plan-tools.md`, paths)).toBe("tools-stats")
  })

  it("classifies agent docs, sessions, journal, and skill candidates", () => {
    const dir = "Claude/Plans/2026/06-June/10-Wednesday/001-slug"
    expect(classifyDoc(`${dir}/agents/7-explore-something.md`, paths)).toBe("agent")
    expect(classifyDoc("Claude/Sessions/p4c-portal/024-6c3f4e99.md", paths)).toBe("session")
    expect(classifyDoc("Claude/Journal/2026/06-June/10-Wednesday.md", paths)).toBe("journal")
    expect(classifyDoc(`${dir}/simplify.md`, paths)).toBe("skill")
  })

  it("skips internal state, e2e artifacts, and out-of-tree files", () => {
    const dir = "Claude/Plans/2026/06-June/10-Wednesday/001-slug"
    expect(classifyDoc(`${dir}/state.md`, paths)).toBeNull()
    expect(classifyDoc(`${dir}/test-log.md`, paths)).toBeNull()
    expect(
      classifyDoc(
        "Claude/Plans/2026/04-April/03-Friday/019-e2e-test-synthetic-widget/plan.md",
        paths,
      ),
    ).toBeNull()
    expect(
      classifyDoc(
        "Claude/Plans/2026/06-June/01-Monday/001-x/plan.md".replace("001-x", "001-test-project-1"),
        paths,
      ),
    ).toBeNull()
    expect(classifyDoc("Other/notes.md", paths)).toBeNull()
    expect(classifyDoc("Claude/Plans/foo.base", paths)).toBeNull()
  })
})

describe("parseDurationToSeconds", () => {
  it("parses the duration display formats the hooks emit", () => {
    expect(parseDurationToSeconds("0s")).toBe(0)
    expect(parseDurationToSeconds("11s")).toBe(11)
    expect(parseDurationToSeconds("3m 5s")).toBe(185)
    expect(parseDurationToSeconds("3m")).toBe(180)
    expect(parseDurationToSeconds("1h 5m")).toBe(3900)
    expect(parseDurationToSeconds("1h")).toBe(3600)
    expect(parseDurationToSeconds("122.6s")).toBe(123)
    expect(parseDurationToSeconds("850ms")).toBe(1)
  })

  it("returns null for unparseable input", () => {
    expect(parseDurationToSeconds("")).toBeNull()
    expect(parseDurationToSeconds("unknown")).toBeNull()
  })
})

describe("parseModelContextWindow", () => {
  it("parses both legacy suffix styles", () => {
    expect(parseModelContextWindow("claude-opus-4-8 (1M)")).toBe(1_000_000)
    expect(parseModelContextWindow("claude-sonnet-4 (200K)")).toBe(200_000)
    expect(parseModelContextWindow("claude-opus-4-8[1m]")).toBe(1_000_000)
  })

  it("returns undefined for bare ids", () => {
    expect(parseModelContextWindow("claude-opus-4-8")).toBeUndefined()
  })
})

describe("deriveDate", () => {
  it("prefers the created wikilink alias", () => {
    const fm = 'created: "[[Claude/Journal/2026/06-June/10-Wednesday|2026-06-10T15:53]]"'
    expect(deriveDate(fm, "Claude/Plans/2026/05-May/01-Friday/001-x/plan.md")).toBe("2026-06-10")
  })

  it("falls back to started for session docs", () => {
    expect(deriveDate('started: "2026-06-11T19:08:58.953Z"', "Claude/Sessions/p/001-x.md")).toBe(
      "2026-06-11",
    )
  })

  it("falls back to date segments in the path for each scheme", () => {
    expect(deriveDate("", "Claude/Plans/2026/06-June/10-Wednesday/001-x/plan.md")).toBe(
      "2026-06-10",
    )
    expect(deriveDate("", "Claude/Plans/2026/06-June/10/001-x/plan.md")).toBe("2026-06-10")
    expect(deriveDate("", "Claude/Plans/2026/06-10/001-x/plan.md")).toBe("2026-06-10")
    expect(deriveDate("", "Claude/Plans/2026-06-10/001-x/plan.md")).toBe("2026-06-10")
    expect(deriveDate("", "Claude/Journal/2026/06-June/10-Wednesday.md")).toBe("2026-06-10")
    expect(deriveDate("", "Claude/Journal/2026-06-10.md")).toBe("2026-06-10")
  })

  it("returns null when nothing derivable", () => {
    expect(deriveDate("project: x", "Claude/Sessions/p/001-x.md")).toBeNull()
  })
})

describe("upgradeNoteContent", () => {
  const planRel = "Claude/Plans/2026/06-June/10-Wednesday/001-slug/tools-stats.md"

  const legacyToolsStats = `---
created: "[[Claude/Journal/2026/06-June/10-Wednesday|2026-06-10T15:53]]"
plan: "[[Claude/Plans/2026/06-June/10-Wednesday/001-slug/plan|Title]]"
project: p4c-k8s
cc_version: "v2.1.172"
model: claude-opus-4-8 (1M)
duration: "11s"
tokens_in: 11608
tokens_out: 3853
context_pct: 2
---
# Session Tools: Title

Body stays byte-identical | even [[with|links]].
`

  it("adds type, date, duration_s, normalizes model, adds context_window", () => {
    const result = upgradeNoteContent(planRel, legacyToolsStats, "tools-stats")
    expect(result).not.toBeNull()
    const content = result?.content ?? ""
    expect(content.startsWith("---\ntype: tools-stats\ndate: 2026-06-10\n")).toBe(true)
    expect(content).toContain("model: claude-opus-4-8\ncontext_window: 1000000")
    expect(content).toContain('duration: "11s"\nduration_s: 11')
    expect(content.endsWith("Body stays byte-identical | even [[with|links]].\n")).toBe(true)
    expect(result?.changes.map((c) => c.key).sort()).toEqual([
      "context_window",
      "date",
      "duration_s",
      "model",
      "type",
    ])
  })

  it("is idempotent — upgraded content needs no further changes", () => {
    const first = upgradeNoteContent(planRel, legacyToolsStats, "tools-stats")
    const again = upgradeNoteContent(planRel, first?.content ?? "", "tools-stats")
    expect(again).toBeNull()
  })

  it("normalizes session docs with bracket-style model and quoted values", () => {
    const sessionDoc = `---
session_id: "6c3f4e99-3ff5-4c0b-b388-b08469b22c5d"
project: "p4c-portal"
started: "2026-06-11T19:08:58.953Z"
model: "claude-opus-4-8[1m]"
cc_version: "v2.1.173"
mode: normal
---
# Session Log
`
    const result = upgradeNoteContent("Claude/Sessions/p4c-portal/024-x.md", sessionDoc, "session")
    const content = result?.content ?? ""
    expect(content).toContain("type: session")
    expect(content).toContain("date: 2026-06-11")
    expect(content).toContain('model: "claude-opus-4-8"\ncontext_window: 1000000')
  })

  it("only adds type to journal notes that already carry a date", () => {
    const journal = `---
date: 2026-06-10
day: Wednesday
plans: 20
projects:
  - p4c-k8s
---
> [!plan]+ stuff
`
    const result = upgradeNoteContent(
      "Claude/Journal/2026/06-June/10-Wednesday.md",
      journal,
      "journal",
    )
    expect(result?.changes.map((c) => c.key)).toEqual(["type"])
    expect(result?.content.startsWith("---\ntype: journal\ndate: 2026-06-10\n")).toBe(true)
  })

  it("skips skill candidates without source: skill", () => {
    const userNote = `---
created: "[[Claude/Journal/2026/06-June/10-Wednesday|2026-06-10T15:53]]"
---
some note
`
    expect(
      upgradeNoteContent(
        "Claude/Plans/2026/06-June/10-Wednesday/001-slug/notes.md",
        userNote,
        "skill",
      ),
    ).toBeNull()
  })

  it("upgrades genuine mixed-session skill notes", () => {
    const skillNote = `---
created: "[[Claude/Journal/2026/06-June/10-Wednesday|2026-06-10T15:53]]"
plan: "[[Claude/Plans/2026/06-June/10-Wednesday/001-slug/plan|Title]]"
source: skill
skill: simplify
---
# simplify
`
    const result = upgradeNoteContent(
      "Claude/Plans/2026/06-June/10-Wednesday/001-slug/simplify.md",
      skillNote,
      "skill",
    )
    expect(result?.changes.map((c) => c.key).sort()).toEqual(["date", "type"])
  })

  it("returns null for notes without frontmatter or with malformed frontmatter", () => {
    expect(upgradeNoteContent(planRel, "no frontmatter here", "tools-stats")).toBeNull()
    expect(upgradeNoteContent(planRel, "---\nunclosed: yes\n", "tools-stats")).toBeNull()
  })

  it("leaves bare models alone and still adds missing scalar fields", () => {
    const toolsLog = `---
created: "[[Claude/Journal/2026/06-June/10-Wednesday|2026-06-10T15:53]]"
model: claude-opus-4-8
total_tool_calls: 11
duration: "3m 5s"
tokens_in: 308134
---
# Tool Log
`
    const result = upgradeNoteContent(planRel, toolsLog, "tools-log")
    const content = result?.content ?? ""
    expect(content).toContain("model: claude-opus-4-8\ntotal_tool_calls: 11")
    expect(content).not.toContain("context_window:")
    expect(content).toContain('duration: "3m 5s"\nduration_s: 185')
  })
})
