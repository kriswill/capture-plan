// config-cascade-overrides.test.ts — Verifies that each config layer overrides lower layers
// and that source attribution is correct for every option in the matrix.

import { describe, expect, it } from "bun:test"
import { EXPECTED_OPTIONS, findOption, runPrintConfig, tomlFor } from "./_config-cascade-helpers.ts"

describe("plugin layer overrides default", () => {
  it.each(EXPECTED_OPTIONS)("$key", async (spec) => {
    const output = await runPrintConfig({
      pluginToml: tomlFor(spec, spec.pluginSample),
    })
    const option = findOption(output.options, spec.key)
    expect(option.value).toEqual(spec.pluginSample)
    expect(option.source).toBe("plugin")
  })
})

describe("user layer overrides plugin", () => {
  it.each(EXPECTED_OPTIONS)("$key", async (spec) => {
    // session.enabled: plugin=true, user=false — user wins, value is false
    const output = await runPrintConfig({
      pluginToml: tomlFor(spec, spec.pluginSample),
      userToml: tomlFor(spec, spec.userSample),
    })
    const option = findOption(output.options, spec.key)
    expect(option.value).toEqual(spec.userSample)
    expect(option.source).toBe("user")
  })
})

describe("project layer overrides user", () => {
  it.each(EXPECTED_OPTIONS)("$key", async (spec) => {
    const output = await runPrintConfig({
      pluginToml: tomlFor(spec, spec.pluginSample),
      userToml: tomlFor(spec, spec.userSample),
      projectToml: tomlFor(spec, spec.projectSample),
    })
    const option = findOption(output.options, spec.key)
    expect(option.value).toEqual(spec.projectSample)
    expect(option.source).toBe("project")
  })
})
