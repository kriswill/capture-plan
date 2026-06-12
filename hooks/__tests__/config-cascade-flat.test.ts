// config-cascade-flat.test.ts — Tests for legacy flat-key fallbacks in config cascade

import { describe, expect, it } from "bun:test"
import {
  EXPECTED_OPTIONS,
  findOption,
  flatTomlFor,
  runPrintConfig,
} from "./_config-cascade-helpers"

describe("legacy flat-key fallbacks", () => {
  const FLAT_OPTIONS = EXPECTED_OPTIONS.filter((s) => s.flatKey !== undefined)

  it("registers exactly 3 flat-aliased options", () => {
    expect(FLAT_OPTIONS.length).toBe(3)
    const keys = FLAT_OPTIONS.map((s) => s.key)
    expect(keys).toContain("plan.path")
    expect(keys).toContain("journal.path")
    expect(keys).toContain("skills.path")
  })

  it.each(FLAT_OPTIONS)("flat key $flatKey is read as $key from project layer", async (spec) => {
    const output = await runPrintConfig({
      projectToml: flatTomlFor(spec, spec.projectSample),
    })
    const option = findOption(output.options, spec.key)
    expect(option.value).toBe(spec.projectSample)
    expect(option.source).toBe("project")
  })

  it("plan_path flat key only affects plan.path — no bleed to journal.path or skills.path", async () => {
    const output = await runPrintConfig({
      projectToml: 'plan_path = "p-only"\n',
    })

    const planOption = findOption(output.options, "plan.path")
    expect(planOption.value).toBe("p-only")
    expect(planOption.source).toBe("project")

    const journalOption = findOption(output.options, "journal.path")
    expect(journalOption.source).toBe("default")

    const skillsOption = findOption(output.options, "skills.path")
    expect(skillsOption.source).toBe("default")
  })
})
