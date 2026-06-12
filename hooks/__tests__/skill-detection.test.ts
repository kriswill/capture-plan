import { describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../transcript.ts"
import {
  filterSkillInvocations,
  findSkillInvocations,
  transcriptContainsPattern,
} from "../transcript.ts"
import {
  assistantEntry,
  humanEntry,
  skillEntry,
  slashCommandEntry,
} from "./helpers/transcript-helpers.ts"

describe("findSkillInvocations", () => {
  it("returns empty array when no skills used", () => {
    const entries: TranscriptEntry[] = [
      assistantEntry({ tools: [{ name: "Edit" }] }),
      humanEntry(),
      assistantEntry(),
    ]
    expect(findSkillInvocations(entries)).toEqual([])
  })

  it("detects a single skill invocation", () => {
    const entries: TranscriptEntry[] = [
      assistantEntry(),
      skillEntry("simplify"),
      humanEntry(),
      assistantEntry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Simplified 3 functions" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(1)
    expect(result[0].skill).toBe("simplify")
    expect(result[0].index).toBe(1)
    expect(result[0].args).toBeUndefined()
  })

  it("captures skill args when provided", () => {
    const entries: TranscriptEntry[] = [skillEntry("simplify", "--verbose")]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(1)
    expect(result[0].args).toBe("--verbose")
  })

  it("captures contextBefore from the same turn", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("simplify", undefined, {
        textBefore: "Let me review the code quality.",
      }),
      humanEntry(),
    ]
    const result = findSkillInvocations(entries)
    expect(result[0].contextBefore).toBe("Let me review the code quality.")
  })

  it("captures contextAfter from the next assistant turn", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("simplify"),
      humanEntry(), // tool result
      assistantEntry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Simplified 3 functions successfully." }],
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      }),
    ]
    const result = findSkillInvocations(entries)
    expect(result[0].contextAfter).toBe("Simplified 3 functions successfully.")
  })

  it("detects multiple skill invocations", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("simplify"),
      humanEntry(),
      assistantEntry(),
      skillEntry("test-driven-development"),
      humanEntry(),
      assistantEntry(),
    ]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(2)
    expect(result[0].skill).toBe("simplify")
    expect(result[1].skill).toBe("test-driven-development")
  })

  it("ignores non-Skill tool_use blocks", () => {
    const entries: TranscriptEntry[] = [
      assistantEntry({ tools: [{ name: "Edit" }, { name: "Write" }] }),
      assistantEntry({ tools: [{ name: "Bash" }] }),
    ]
    expect(findSkillInvocations(entries)).toEqual([])
  })

  it("returns empty contextAfter when no assistant turn follows", () => {
    const entries: TranscriptEntry[] = [skillEntry("simplify")]
    const result = findSkillInvocations(entries)
    expect(result[0].contextAfter).toBe("")
  })

  it("returns empty contextBefore when skill has no preceding text", () => {
    const entries: TranscriptEntry[] = [skillEntry("simplify")]
    const result = findSkillInvocations(entries)
    expect(result[0].contextBefore).toBe("")
  })

  it("detects user-typed slash command (no Skill tool_use)", () => {
    const entries: TranscriptEntry[] = [
      slashCommandEntry("code-review", "2931142"),
      assistantEntry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Reviewing CL 2931142." }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(1)
    expect(result[0].skill).toBe("code-review")
    expect(result[0].args).toBe("2931142")
    expect(result[0].index).toBe(0)
    expect(result[0].contextBefore).toBe("")
    expect(result[0].contextAfter).toBe("Reviewing CL 2931142.")
  })

  it("treats empty <command-args> as undefined", () => {
    const entries: TranscriptEntry[] = [slashCommandEntry("clear", "")]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(1)
    expect(result[0].skill).toBe("clear")
    expect(result[0].args).toBeUndefined()
  })

  it("does not double-count when slash command and Skill tool_use refer to the same turn", () => {
    // Defensive: slash command is always in a user entry, Skill tool_use in an assistant entry,
    // so distinct indices — both should be reported, but never as duplicates at the same index.
    const entries: TranscriptEntry[] = [slashCommandEntry("simplify"), skillEntry("simplify")]
    const result = findSkillInvocations(entries)
    expect(result).toHaveLength(2)
    expect(result[0].index).toBe(0)
    expect(result[1].index).toBe(1)
  })

  it("respects whitelist filtering for slash-command invocations", () => {
    const entries: TranscriptEntry[] = [
      slashCommandEntry("code-review", "1234"),
      slashCommandEntry("clear"),
    ]
    const invocations = findSkillInvocations(entries)
    const filtered = filterSkillInvocations(invocations, ["code-review"])
    expect(filtered).toHaveLength(1)
    expect(filtered[0].skill).toBe("code-review")
  })
})

describe("transcriptContainsPattern for skills", () => {
  it("detects Skill tool_use in raw JSONL", () => {
    const tempDir = join(tmpdir(), `cp-skill-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const file = join(tempDir, "test.jsonl")
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Skill", input: { skill: "simplify" } }],
      },
    })
    writeFileSync(file, line)

    expect(transcriptContainsPattern(file, ['"Skill"'])).toBe(true)
    Bun.spawnSync(["rm", "-rf", tempDir])
  })

  it("returns false when no Skill in transcript", () => {
    const tempDir = join(tmpdir(), `cp-skill-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const file = join(tempDir, "test.jsonl")
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/x" } }],
      },
    })
    writeFileSync(file, line)

    expect(transcriptContainsPattern(file, ['"Skill"'])).toBe(false)
    Bun.spawnSync(["rm", "-rf", tempDir])
  })
})

describe("filterSkillInvocations", () => {
  it("returns all invocations when captureSkills is undefined", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("simplify"),
      humanEntry(),
      skillEntry("start-dev"),
    ]
    const invocations = findSkillInvocations(entries)
    expect(filterSkillInvocations(invocations, undefined)).toHaveLength(2)
  })

  it("returns empty array when captureSkills is empty", () => {
    const entries: TranscriptEntry[] = [skillEntry("simplify")]
    const invocations = findSkillInvocations(entries)
    expect(filterSkillInvocations(invocations, [])).toHaveLength(0)
  })

  it("keeps only whitelisted skills", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("start-dev"),
      humanEntry(),
      skillEntry("simplify"),
      humanEntry(),
      skillEntry("end-dev"),
    ]
    const invocations = findSkillInvocations(entries)
    const filtered = filterSkillInvocations(invocations, ["simplify"])
    expect(filtered).toHaveLength(1)
    expect(filtered[0].skill).toBe("simplify")
  })

  it("returns empty when no invocations match the whitelist", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("start-dev"),
      humanEntry(),
      skillEntry("test-e2e"),
    ]
    const invocations = findSkillInvocations(entries)
    expect(filterSkillInvocations(invocations, ["simplify"])).toHaveLength(0)
  })

  it("keeps multiple whitelisted skills", () => {
    const entries: TranscriptEntry[] = [
      skillEntry("simplify"),
      humanEntry(),
      skillEntry("test-driven-development"),
      humanEntry(),
      skillEntry("start-dev"),
    ]
    const invocations = findSkillInvocations(entries)
    const filtered = filterSkillInvocations(invocations, ["simplify", "test-driven-development"])
    expect(filtered).toHaveLength(2)
    expect(filtered[0].skill).toBe("simplify")
    expect(filtered[1].skill).toBe("test-driven-development")
  })
})

describe("mixed session handling", () => {
  it("detects skills in a session that already has plan-mode state", () => {
    const entries: TranscriptEntry[] = [
      assistantEntry(), // planning phase
      assistantEntry({ tools: [{ name: "ExitPlanMode" }] }),
      humanEntry(),
      assistantEntry({ tools: [{ name: "Edit" }] }), // execution
      humanEntry(),
      skillEntry("simplify"),
      humanEntry(),
      assistantEntry({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Simplified the code." }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ]

    const invocations = findSkillInvocations(entries)
    expect(invocations).toHaveLength(1)
    expect(invocations[0].skill).toBe("simplify")
  })
})
