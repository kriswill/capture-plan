// context-hint-upsert.test.ts — upsertContextHint / updateContextHint / mergePriorWatermarks
//
// The re-capture watermark lives in the context-hint tmp file. These tests cover the
// lazy-create upsert (watermarks must never be silently dropped), round-tripping of the
// watermark keys, and the SessionStart carry-over that survives resume/compact rewrites.

import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import type { ContextHint } from "../shared.ts"
import {
  contextHintPath,
  mergePriorWatermarks,
  readContextHintFull,
  updateContextHint,
  upsertContextHint,
} from "../shared.ts"

const SKILL_DIR = "Claude/Skills/2026/06-12/004-orig-slug"

/** Track created hint files so each test cleans up after itself. */
const createdSessionIds: string[] = []

/** Write a hint file to the real tmpdir and register it for cleanup. */
function seedHint(sessionId: string, hint: ContextHint): void {
  writeFileSync(contextHintPath(sessionId), JSON.stringify(hint))
  createdSessionIds.push(sessionId)
}

/** Register a session id for cleanup without seeding (upsert creates the file). */
function trackSession(sessionId: string): string {
  createdSessionIds.push(sessionId)
  return sessionId
}

afterEach(() => {
  for (const id of createdSessionIds.splice(0)) {
    const p = contextHintPath(id)
    if (existsSync(p)) rmSync(p)
  }
})

describe("upsertContextHint", () => {
  it("merges watermark keys into an existing hint, preserving unrelated keys", () => {
    const sessionId = trackSession(`upsert-merge-${process.pid}`)
    seedHint(sessionId, {
      session_id: sessionId,
      source: "startup",
      session_enabled: true,
      cc_version: "v2.1.0",
      session_doc_path: "Claude/Sessions/doc",
      plan_dir: SKILL_DIR,
    })

    upsertContextHint(
      sessionId,
      { plan_dir: undefined, captured_skill_dir: SKILL_DIR, captured_skill_count: 2 },
      { session_enabled: false },
    )

    const hint = readContextHintFull(sessionId)
    expect(hint?.cc_version).toBe("v2.1.0")
    expect(hint?.session_doc_path).toBe("Claude/Sessions/doc")
    expect(hint?.session_enabled).toBe(true) // init values must not clobber an existing hint
    expect(hint?.captured_skill_dir).toBe(SKILL_DIR)
    expect(hint?.captured_skill_count).toBe(2)
    // plan_dir: undefined clears the key after the JSON round-trip
    expect(hint?.plan_dir).toBeUndefined()
  })

  it("bootstraps a minimal hint file when none exists (watermark never dropped)", () => {
    const sessionId = trackSession(`upsert-bootstrap-${process.pid}`)
    expect(readContextHintFull(sessionId)).toBeNull()

    upsertContextHint(
      sessionId,
      { captured_skill_dir: SKILL_DIR, captured_skill_count: 1, captured_skill_title: "T" },
      { session_enabled: true },
    )

    const hint = readContextHintFull(sessionId)
    expect(hint).not.toBeNull()
    expect(hint?.session_id).toBe(sessionId)
    expect(hint?.source).toBe("stop-bootstrap")
    expect(hint?.session_enabled).toBe(true)
    expect(hint?.captured_skill_dir).toBe(SKILL_DIR)
    expect(hint?.captured_skill_count).toBe(1)
    expect(hint?.captured_skill_title).toBe("T")
  })
})

describe("updateContextHint — widened watermark keys", () => {
  it("round-trips all six captured_* keys", () => {
    const sessionId = trackSession(`update-roundtrip-${process.pid}`)
    seedHint(sessionId, { session_id: sessionId, source: "startup", session_enabled: false })

    updateContextHint(sessionId, {
      captured_skill_dir: SKILL_DIR,
      captured_skill_count: 3,
      captured_skill_title: "Skill Title",
      captured_sp_dir: "Claude/Plans/2026/06-12/001-sp",
      captured_sp_count: 1,
      captured_sp_title: "SP Title",
    })

    const hint = readContextHintFull(sessionId)
    expect(hint?.captured_skill_dir).toBe(SKILL_DIR)
    expect(hint?.captured_skill_count).toBe(3)
    expect(hint?.captured_skill_title).toBe("Skill Title")
    expect(hint?.captured_sp_dir).toBe("Claude/Plans/2026/06-12/001-sp")
    expect(hint?.captured_sp_count).toBe(1)
    expect(hint?.captured_sp_title).toBe("SP Title")
  })
})

describe("mergePriorWatermarks", () => {
  const fresh: ContextHint = {
    session_id: "merge-session",
    source: "resume",
    session_enabled: false,
    model: "claude-opus-4-8",
  }

  it("returns the fresh hint unchanged when there is no prior hint", () => {
    expect(mergePriorWatermarks(fresh, null)).toEqual(fresh)
  })

  it("carries watermarks from the prior hint into the fresh one", () => {
    const prior: ContextHint = {
      session_id: "merge-session",
      source: "startup",
      session_enabled: true,
      captured_skill_dir: SKILL_DIR,
      captured_skill_count: 2,
      captured_skill_title: "Orig Title",
      captured_sp_count: 1,
    }
    const merged = mergePriorWatermarks(fresh, prior)
    expect(merged.captured_skill_dir).toBe(SKILL_DIR)
    expect(merged.captured_skill_count).toBe(2)
    expect(merged.captured_skill_title).toBe("Orig Title")
    expect(merged.captured_sp_count).toBe(1)
    // fresh (non-watermark) fields win over prior
    expect(merged.source).toBe("resume")
    expect(merged.session_enabled).toBe(false)
    expect(merged.model).toBe("claude-opus-4-8")
  })

  it("does not invent watermark keys absent from the prior hint", () => {
    const prior: ContextHint = {
      session_id: "merge-session",
      source: "startup",
      session_enabled: false,
    }
    const merged = mergePriorWatermarks(fresh, prior)
    expect("captured_skill_dir" in merged).toBe(false)
    expect("captured_sp_count" in merged).toBe(false)
  })
})
