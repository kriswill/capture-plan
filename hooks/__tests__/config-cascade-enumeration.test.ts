// config-cascade-enumeration.test.ts — Asserts that print-config enumerates every
// config option and reports correct defaults when no layer sets anything.

import { beforeAll, describe, expect, it } from "bun:test"
import {
  EXPECTED_OPTIONS,
  findOption,
  type PrintConfigOutput,
  runPrintConfig,
} from "./_config-cascade-helpers"

// Shared result — both describe blocks use this single subprocess invocation.
let output: PrintConfigOutput

beforeAll(async () => {
  output = await runPrintConfig({})
})

describe("print-config enumerates every config option", () => {
  it("emits exactly the expected set of option keys", () => {
    const actual = output.options.map((o) => o.key).sort()
    const expected = EXPECTED_OPTIONS.map((s) => s.key).sort()
    expect(actual).toEqual(expected)
    // Catches duplicate registrations independently of the sorted-equality check.
    expect(output.options.length).toBe(EXPECTED_OPTIONS.length)
  })
})

describe("default value and source when no layer sets the option", () => {
  it.each(EXPECTED_OPTIONS)('"%s" reports default', (spec) => {
    const option = findOption(output.options, spec.key)
    expect(option.source).toBe("default")
    expect(option.value).toEqual(spec.defaultValue)
  })
})
