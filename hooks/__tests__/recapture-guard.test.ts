// recapture-guard.test.ts — decideRecapture / buildCaptureWatermark decision table
//
// Guards against the per-turn duplicate-capture bug: the Stop hook fires after every
// assistant turn, and once a capture is consumed the cumulative transcript still
// contains its source signals. The watermark in the context hint is what stops a
// fresh `<counter>-<same-slug>` directory from being allocated on every turn.

import { describe, expect, it } from "bun:test"
import type { ContextHint, SessionState } from "../shared.ts"
import { buildCaptureWatermark, decideRecapture } from "../shared.ts"

const SESSION_ID = "recapture-session"
const SKILL_DIR = "Claude/Skills/2026/06-12/004-orig-slug"
const SP_DIR = "Claude/Plans/2026/06-12/002-sp-plan"

/** Build a ContextHint with sensible defaults for fields irrelevant to this suite. */
function makeHint(overrides: Partial<ContextHint> = {}): ContextHint {
  return {
    session_id: SESSION_ID,
    source: "test",
    session_enabled: false,
    ...overrides,
  }
}

/** Build a SessionState with sensible defaults. */
function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: SESSION_ID,
    plan_slug: "orig-slug",
    plan_title: "Orig Title",
    plan_dir: SKILL_DIR,
    date_key: "2026-06-12",
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

describe("decideRecapture", () => {
  it("skips at zero detected count (subsumes the empty-invocations exit)", () => {
    expect(decideRecapture("skill", 0, null)).toEqual({ action: "skip" })
    expect(decideRecapture("superpowers", 0, makeHint())).toEqual({ action: "skip" })
  })

  it("captures without reuse when no watermark exists (first capture / hint missing)", () => {
    expect(decideRecapture("skill", 2, null)).toEqual({ action: "capture", reuse: undefined })
    expect(decideRecapture("skill", 2, makeHint())).toEqual({ action: "capture", reuse: undefined })
  })

  it("skips when detected count equals the watermark (second Stop, nothing new)", () => {
    const hint = makeHint({ captured_skill_count: 2 })
    expect(decideRecapture("skill", 2, hint)).toEqual({ action: "skip" })
  })

  it("skips when detected count is below the watermark (post-compact transcript)", () => {
    const hint = makeHint({ captured_skill_count: 5 })
    expect(decideRecapture("skill", 3, hint)).toEqual({ action: "skip" })
  })

  it("captures with directory reuse when new invocations appear", () => {
    const hint = makeHint({
      captured_skill_count: 2,
      captured_skill_dir: SKILL_DIR,
      captured_skill_title: "Orig Title",
    })
    expect(decideRecapture("skill", 3, hint)).toEqual({
      action: "capture",
      reuse: { planDir: SKILL_DIR, title: "Orig Title" },
    })
  })

  it("captures WITHOUT reuse for a count-only watermark (mixed-session follow-up gets a fresh dir)", () => {
    const hint = makeHint({ captured_skill_count: 2 })
    expect(decideRecapture("skill", 3, hint)).toEqual({ action: "capture", reuse: undefined })
  })

  it("superpowers mirror: skip at watermark, reuse above it", () => {
    const hint = makeHint({
      captured_sp_count: 1,
      captured_sp_dir: SP_DIR,
      captured_sp_title: "SP Plan",
    })
    expect(decideRecapture("superpowers", 1, hint)).toEqual({ action: "skip" })
    expect(decideRecapture("superpowers", 2, hint)).toEqual({
      action: "capture",
      reuse: { planDir: SP_DIR, title: "SP Plan" },
    })
  })

  it("skill and superpowers watermarks do not cross-contaminate", () => {
    const skillOnly = makeHint({
      captured_skill_count: 3,
      captured_skill_dir: SKILL_DIR,
      captured_skill_title: "Orig Title",
    })
    // sp decision must ignore the skill watermark entirely
    expect(decideRecapture("superpowers", 1, skillOnly)).toEqual({
      action: "capture",
      reuse: undefined,
    })

    const spOnly = makeHint({
      captured_sp_count: 3,
      captured_sp_dir: SP_DIR,
      captured_sp_title: "SP Plan",
    })
    expect(decideRecapture("skill", 1, spOnly)).toEqual({ action: "capture", reuse: undefined })
  })
})

describe("buildCaptureWatermark", () => {
  it("skill source records exactly the skill triplet", () => {
    const state = makeState({ source: "skill" })
    expect(buildCaptureWatermark(state, 0, 3)).toEqual({
      captured_skill_dir: SKILL_DIR,
      captured_skill_count: 3,
      captured_skill_title: "Orig Title",
    })
  })

  it("skill source with count 0 still records dir+title (self-healing summary retry)", () => {
    const state = makeState({ source: "skill" })
    expect(buildCaptureWatermark(state, 0, 0)).toEqual({
      captured_skill_dir: SKILL_DIR,
      captured_skill_count: 0,
      captured_skill_title: "Orig Title",
    })
  })

  it("superpowers source records the sp triplet plus a count-only skill guard with offset", () => {
    const state = makeState({ source: "superpowers", plan_dir: SP_DIR, plan_title: "SP Plan" })
    expect(buildCaptureWatermark(state, 2, 2)).toEqual({
      captured_sp_dir: SP_DIR,
      captured_sp_count: 2,
      captured_sp_title: "SP Plan",
      captured_skill_count: 2,
      captured_skill_offset: 2,
    })
  })

  it("superpowers source with no skills records only the sp triplet", () => {
    const state = makeState({ source: "superpowers", plan_dir: SP_DIR, plan_title: "SP Plan" })
    const patch = buildCaptureWatermark(state, 2, 0)
    expect(patch).toEqual({
      captured_sp_dir: SP_DIR,
      captured_sp_count: 2,
      captured_sp_title: "SP Plan",
    })
    expect(patch.captured_skill_dir).toBeUndefined()
    expect(patch.captured_skill_count).toBeUndefined()
  })

  it("superpowers consume-without-summary keeps dir+title with count 0 (guard stays open)", () => {
    // Contract for the no-execution and summary-create-failure consume sites:
    // recording the full spWriteCount there would skip every later Stop and
    // silently lose the execution summary.
    const state = makeState({ source: "superpowers", plan_dir: SP_DIR, plan_title: "SP Plan" })
    const patch = buildCaptureWatermark(state, 0, 0)
    expect(patch).toEqual({
      captured_sp_dir: SP_DIR,
      captured_sp_count: 0,
      captured_sp_title: "SP Plan",
    })

    // A later Stop that re-detects the same writes must re-capture into the same dir
    const hint = makeHint(patch)
    expect(decideRecapture("superpowers", 1, hint)).toEqual({
      action: "capture",
      reuse: { planDir: SP_DIR, title: "SP Plan" },
    })
  })

  it("plan-mode source records nothing without skills", () => {
    const state = makeState({ source: undefined })
    expect(buildCaptureWatermark(state, 0, 0)).toEqual({})
  })

  it("plan-mode source with skills records a count-only skill guard plus offset (no dir — never reuse the plan dir)", () => {
    const state = makeState({ source: undefined })
    const patch = buildCaptureWatermark(state, 0, 2)
    expect(patch).toEqual({ captured_skill_count: 2, captured_skill_offset: 2 })
    expect(patch.captured_skill_dir).toBeUndefined()
    expect(patch.captured_skill_title).toBeUndefined()
  })

  it("plan-mode source with superpowers writes records a count-only sp guard (no dir)", () => {
    const state = makeState({ source: undefined })
    const patch = buildCaptureWatermark(state, 2, 0)
    expect(patch).toEqual({ captured_sp_count: 2 })
    expect(patch.captured_sp_dir).toBeUndefined()
    expect(patch.captured_sp_title).toBeUndefined()

    // Next Stop re-detecting the same writes must skip, not rebuild a duplicate dir
    expect(decideRecapture("superpowers", 2, makeHint(patch))).toEqual({ action: "skip" })
    // Genuinely new writes capture into a FRESH dir (no reuse of the plan dir)
    expect(decideRecapture("superpowers", 3, makeHint(patch))).toEqual({
      action: "capture",
      reuse: undefined,
    })
  })

  it("plan-mode source with both skills and superpowers writes records both count-only guards", () => {
    const state = makeState({ source: undefined })
    expect(buildCaptureWatermark(state, 2, 3)).toEqual({
      captured_sp_count: 2,
      captured_skill_count: 3,
      captured_skill_offset: 3,
    })
  })

  it("skill source never sets the offset — the merge preserves the dir's original offset", () => {
    // A skill capture's dir covers invocations from its original offset onward; the
    // consume patch must not include the key, so upsertContextHint's merge keeps it.
    const state = makeState({ source: "skill" })
    expect("captured_skill_offset" in buildCaptureWatermark(state, 0, 5)).toBe(false)
  })
})
