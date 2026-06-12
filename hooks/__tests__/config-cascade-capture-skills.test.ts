import { describe, expect, it } from "bun:test"
import { findOption, runPrintConfig } from "./_config-cascade-helpers.ts"

describe("capture_skills TOML scoping regression", () => {
  it("reads capture_skills from user TOML when placed after [skills] table header", async () => {
    const userToml = [
      'vault = "VCS Notes"',
      "[plan]",
      'path = "P"',
      "[skills]",
      'path = "S"',
      'capture_skills = ["simplify", "code-review"]',
      "",
    ].join("\n")

    const output = await runPrintConfig({ userToml })
    const option = findOption(output.options, "capture_skills")

    expect(option.value).toEqual(["simplify", "code-review"])
    expect(option.source).toBe("user")
  })
})
