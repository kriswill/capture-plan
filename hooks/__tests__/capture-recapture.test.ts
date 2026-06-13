// capture-recapture.test.ts — buildSkillState / buildSuperpowersState directory reuse
//
// Covers the duplicate-directory bug: a re-capture (reuse set) must write into the
// original directory with the original title instead of allocating `nextCounter()+1`
// with a freshly drifted Haiku slug.

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { buildSkillState, buildSuperpowersState } from "../capture-done.ts"
import type { Config } from "../shared.ts"
import type { SkillInvocation, SuperpowersWrite, TranscriptEntry } from "../transcript.ts"

type SpawnResult = {
  exitCode: number
  success: boolean
  stdout: Buffer
  stderr: Buffer
}

const config: Config = {
  vault: "TestVault",
  plan: { path: "Claude/Plans", date_scheme: "calendar" },
  journal: { path: "Journal", date_scheme: "calendar" },
  skills: { path: "Claude/Skills", date_scheme: "calendar" },
  session: { enabled: false, path: "Claude/Sessions" },
  bases: { enabled: false, path: "Claude/Bases" },
}

/** Catch-all Bun.spawnSync spy: records every call, serves a canned sibling dir to
 *  `folders` (so nextCounter sees an existing 007), succeeds silently on everything else. */
function installRecorder(opts: { siblingDir?: string } = {}): {
  restore: () => void
  calls: string[][]
} {
  const calls: string[][] = []
  const spy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[]) => {
    calls.push([...cmd])
    const result: SpawnResult = {
      exitCode: 0,
      success: true,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    }
    if (cmd.includes("folders")) {
      const folderArg = cmd.find((c) => c.startsWith("folder=")) ?? ""
      const folderPath = folderArg.slice("folder=".length)
      result.stdout = Buffer.from(opts.siblingDir ? `${folderPath}/${opts.siblingDir}` : "")
    }
    return result
  }) as typeof Bun.spawnSync)
  return { restore: () => spy.mockRestore(), calls }
}

/** Filter recorded calls to Obsidian `create` invocations targeting the given note name. */
function createCallsFor(calls: string[][], noteName: string): string[][] {
  return calls.filter(
    (c) => c.includes("create") && c.some((a) => a.startsWith("path=") && a.endsWith(noteName)),
  )
}

/** Extract the `content=` argument from a recorded CLI call. */
function contentOf(call: string[]): string {
  return call.find((a) => a.startsWith("content="))?.slice("content=".length) ?? ""
}

const invocations: SkillInvocation[] = [
  {
    index: 0,
    skill: "new-jira-ticket",
    args: "Bug: something broke",
    contextBefore: "Creating a ticket for the broken thing we found earlier today.",
    contextAfter: "Created HCC-1234 and verified the fields landed correctly.",
  },
]

const entries: TranscriptEntry[] = []

const spWrites: SuperpowersWrite[] = [
  {
    index: 0,
    type: "plan",
    filePath: "/proj/superpowers/plans/widget.md",
    title: "Widget Plan",
    content: "# Widget Plan\n\nA plan body that is comfortably longer than twenty characters.",
  },
]

beforeEach(() => {
  process.env.CAPTURE_PLAN_MOCK_SUMMARIZE = "1"
})

afterEach(() => {
  delete process.env.CAPTURE_PLAN_MOCK_SUMMARIZE
})

describe("buildSkillState — directory allocation", () => {
  it("fresh capture allocates max+1 via a folders scan", async () => {
    const { restore, calls } = installRecorder({ siblingDir: "007-existing" })
    const result = await buildSkillState(
      `skill-fresh-${process.pid}`,
      invocations,
      entries,
      { session_id: `skill-fresh-${process.pid}`, cwd: "/tmp/proj" },
      config,
    )
    restore()

    expect(result).not.toBeNull()
    expect(calls.filter((c) => c.includes("folders")).length).toBe(1)
    expect(result?.state.plan_dir).toMatch(/\/008-/)
    const activityCreates = createCallsFor(calls, "/activity")
    expect(activityCreates.length).toBe(1)
    // fresh capture increments the journal frontmatter inside the builder
    expect(calls.some((c) => c.includes("property:set") && c.includes("name=plans"))).toBe(true)
  })

  it("re-capture reuses the original directory and title — no counter scan, no new dir", async () => {
    const reuse = { planDir: "Claude/Skills/2026/06-12/004-orig-slug", title: "Orig Title" }
    const { restore, calls } = installRecorder({ siblingDir: "007-existing" })
    const result = await buildSkillState(
      `skill-reuse-${process.pid}`,
      invocations,
      entries,
      { session_id: `skill-reuse-${process.pid}`, cwd: "/tmp/proj" },
      config,
      undefined,
      reuse,
    )
    restore()

    expect(result).not.toBeNull()
    // no counter allocation at all
    expect(calls.filter((c) => c.includes("folders")).length).toBe(0)
    expect(result?.state.plan_dir).toBe(reuse.planDir)
    expect(result?.state.plan_title).toBe("Orig Title")

    const activityCreates = createCallsFor(calls, "/activity")
    expect(activityCreates.length).toBe(1)
    expect(activityCreates[0]).toContain(`path=${reuse.planDir}/activity`)
    expect(contentOf(activityCreates[0])).toContain("# Orig Title")

    // state.md is re-created in the reused dir for the main flow to consume again
    const stateCreates = createCallsFor(calls, "/state")
    expect(stateCreates.length).toBe(1)
    expect(stateCreates[0]).toContain(`path=${reuse.planDir}/state`)

    // re-capture must not re-increment the journal's plans counter inside the builder...
    expect(calls.some((c) => c.includes("property:set") && c.includes("name=plans"))).toBe(false)
    // ...but the idempotent journal properties still run (a re-capture crossing midnight
    // may have just created a bare new day's journal via the callout append)
    expect(calls.some((c) => c.includes("property:set") && c.includes("name=date"))).toBe(true)
    expect(calls.some((c) => c.includes("property:set") && c.includes("name=day"))).toBe(true)
  })
})

describe("buildSuperpowersState — directory allocation", () => {
  it("fresh capture allocates max+1 via a folders scan", async () => {
    const { restore, calls } = installRecorder({ siblingDir: "002-existing" })
    const result = await buildSuperpowersState(
      `sp-fresh-${process.pid}`,
      spWrites,
      entries,
      { session_id: `sp-fresh-${process.pid}`, cwd: "/tmp/proj" },
      config,
    )
    restore()

    expect(result).not.toBeNull()
    expect(calls.filter((c) => c.includes("folders")).length).toBe(1)
    expect(result?.state.plan_dir).toMatch(/\/003-/)
    expect(result?.state.plan_title).toBe("Widget Plan")
  })

  it("re-capture reuses the original directory and title", async () => {
    const reuse = { planDir: "Claude/Plans/2026/06-12/002-orig-sp", title: "Orig SP Plan" }
    const { restore, calls } = installRecorder({ siblingDir: "002-existing" })
    const result = await buildSuperpowersState(
      `sp-reuse-${process.pid}`,
      spWrites,
      entries,
      { session_id: `sp-reuse-${process.pid}`, cwd: "/tmp/proj" },
      config,
      undefined,
      reuse,
    )
    restore()

    expect(result).not.toBeNull()
    expect(calls.filter((c) => c.includes("folders")).length).toBe(0)
    expect(result?.state.plan_dir).toBe(reuse.planDir)
    expect(result?.state.plan_title).toBe("Orig SP Plan")

    const planCreates = createCallsFor(calls, "/plan")
    expect(planCreates.length).toBe(1)
    expect(planCreates[0]).toContain(`path=${reuse.planDir}/plan`)
    expect(contentOf(planCreates[0])).toContain("# Orig SP Plan")

    expect(calls.some((c) => c.includes("property:set") && c.includes("name=plans"))).toBe(false)
    expect(calls.some((c) => c.includes("property:set") && c.includes("name=date"))).toBe(true)
  })
})
