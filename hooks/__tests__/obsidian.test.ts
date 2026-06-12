import { describe, expect, it } from "bun:test"
import { getDatePartsFor } from "../lib/dates.ts"
import { getPlanDatePath, getSkillDatePath } from "../lib/obsidian.ts"
import type { Config } from "../lib/types.ts"

const BASE_CONFIG: Config = {
  vault: "TestVault",
  plan: { path: "Claude/Plans", date_scheme: "calendar" },
  journal: { path: "Journal", date_scheme: "calendar" },
  skills: { path: "Claude/Skills", date_scheme: "calendar" },
  session: { enabled: false, path: "Claude/Sessions" },
}

const dateParts = getDatePartsFor(new Date())

describe("getSkillDatePath", () => {
  it("path is rooted under config.skills.path", () => {
    const result = getSkillDatePath(BASE_CONFIG, dateParts)
    expect(result.startsWith("Claude/Skills/")).toBe(true)
  })

  it("differs from getPlanDatePath when paths differ", () => {
    const config: Config = {
      ...BASE_CONFIG,
      plan: { path: "Claude/Plans", date_scheme: "calendar" },
      skills: { path: "Claude/Skills", date_scheme: "calendar" },
    }
    const planResult = getPlanDatePath(config, dateParts)
    const skillResult = getSkillDatePath(config, dateParts)
    expect(planResult.startsWith("Claude/Plans/")).toBe(true)
    expect(skillResult.startsWith("Claude/Skills/")).toBe(true)
    expect(planResult).not.toBe(skillResult)
  })

  it("uses config.skills.date_scheme, not config.plan.date_scheme", () => {
    const config: Config = {
      ...BASE_CONFIG,
      plan: { path: "Claude/Plans", date_scheme: "calendar" },
      skills: { path: "Claude/Skills", date_scheme: "flat" },
    }
    const planDatePart = getPlanDatePath(config, dateParts).slice("Claude/Plans/".length)
    const skillDatePart = getSkillDatePath(config, dateParts).slice("Claude/Skills/".length)
    expect(planDatePart).not.toBe(skillDatePart)
  })

  it("matches getPlanDatePath when path and scheme are identical", () => {
    const config: Config = {
      ...BASE_CONFIG,
      plan: { path: "Same/Path", date_scheme: "calendar" },
      skills: { path: "Same/Path", date_scheme: "calendar" },
    }
    expect(getSkillDatePath(config, dateParts)).toBe(getPlanDatePath(config, dateParts))
  })
})
