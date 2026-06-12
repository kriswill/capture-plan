import { describe, expect, it } from "bun:test"
import { findOption, runPrintConfig } from "./_config-cascade-helpers.ts"

describe("stray top-level key warnings", () => {
  it("surfaces a warning when capture_skills is misplaced under [journal] in project TOML", async () => {
    const output = await runPrintConfig({
      projectToml:
        'vault = "Test"\n[plan]\npath = "X"\n[journal]\npath = "Y"\ncapture_skills = ["simplify"]\n',
    })

    expect(Array.isArray(output.warnings)).toBe(true)
    expect((output.warnings ?? []).length).toBeGreaterThanOrEqual(1)
    expect(output.warnings).toContainEqual({
      key: "capture_skills",
      table: "journal",
      layer: "project",
    })
    expect(findOption(output.options, "capture_skills").value).toEqual(["simplify"])
  })

  it("emits no warnings for correctly-placed top-level keys", async () => {
    const output = await runPrintConfig({
      projectToml: 'vault = "Test"\ncapture_skills = ["simplify"]\n[plan]\npath = "X"\n',
    })

    expect(output.warnings ?? []).toEqual([])
  })

  // Recovery surface: every top-level scalar key consumed by loadConfig must be
  // recoverable when scoped under [journal]. The subprocess fixture isolates
  // user-global so we can assert the recovered value reaches the final Config.
  const recoveryCases: Array<{
    key: string
    optionKey: string
    tomlValue: string
    expectedValue: unknown
  }> = [
    { key: "vault", optionKey: "vault", tomlValue: '"VaultX"', expectedValue: "VaultX" },
    { key: "context_cap", optionKey: "context_cap", tomlValue: "500000", expectedValue: 500000 },
    {
      key: "superpowers_spec_pattern",
      optionKey: "superpowers_spec_pattern",
      tomlValue: '"/sp-specs/"',
      expectedValue: "/sp-specs/",
    },
    {
      key: "superpowers_plan_pattern",
      optionKey: "superpowers_plan_pattern",
      tomlValue: '"/sp-plans/"',
      expectedValue: "/sp-plans/",
    },
    { key: "plan_path", optionKey: "plan.path", tomlValue: '"P/Q"', expectedValue: "P/Q" },
    { key: "journal_path", optionKey: "journal.path", tomlValue: '"J/K"', expectedValue: "J/K" },
    { key: "skills_path", optionKey: "skills.path", tomlValue: '"S/T"', expectedValue: "S/T" },
  ]

  for (const tc of recoveryCases) {
    it(`recovers ${tc.key} when misplaced under [journal] and emits a warning`, async () => {
      const output = await runPrintConfig({
        projectToml: `[journal]\ndate_scheme = "calendar"\n${tc.key} = ${tc.tomlValue}\n`,
      })

      expect(findOption(output.options, tc.optionKey).value).toEqual(tc.expectedValue)
      expect(output.warnings).toContainEqual({
        key: tc.key,
        table: "journal",
        layer: "project",
      })
    })
  }
})
