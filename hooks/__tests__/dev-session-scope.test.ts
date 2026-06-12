import { describe, expect, it } from "bun:test"
import { platform } from "node:os"
import { isDevSessionInPluginRepo } from "../lib/types.ts"

describe("isDevSessionInPluginRepo", () => {
  const pluginRoot = "/home/u/capture-plan"

  it("returns true when devMode is on AND cwd equals pluginRoot", () => {
    expect(isDevSessionInPluginRepo("/home/u/capture-plan", pluginRoot, true)).toBe(true)
  })

  it("returns true when devMode is on AND cwd is inside pluginRoot", () => {
    expect(isDevSessionInPluginRepo("/home/u/capture-plan/hooks", pluginRoot, true)).toBe(true)
  })

  it("returns false when devMode is on but cwd is outside pluginRoot", () => {
    expect(isDevSessionInPluginRepo("/some/other/project", pluginRoot, true)).toBe(false)
  })

  it("returns false when devMode is off (regardless of cwd)", () => {
    expect(isDevSessionInPluginRepo(pluginRoot, pluginRoot, false)).toBe(false)
  })

  it("returns false when cwd is undefined", () => {
    expect(isDevSessionInPluginRepo(undefined, pluginRoot, true)).toBe(false)
  })

  it("normalizes path separators / trailing slashes", () => {
    expect(isDevSessionInPluginRepo("/home/u/capture-plan/", pluginRoot, true)).toBe(true)
  })

  it("returns false for sibling dir sharing prefix with pluginRoot", () => {
    expect(isDevSessionInPluginRepo("/home/u/capture-plan2", pluginRoot, true)).toBe(false)
  })

  // Windows-only: when cwd and pluginRoot are on different drives, `path.relative`
  // returns an absolute path (e.g. "D:\..."), which neither equals "" nor starts
  // with "..". Without an isAbsolute() guard, the predicate would incorrectly
  // tag a project on a different drive as "in plugin repo" and skip skill capture.
  const itWin = platform() === "win32" ? it : it.skip
  itWin("returns false when cwd is on a different drive than pluginRoot (Windows)", () => {
    expect(
      isDevSessionInPluginRepo(
        "D:\\Perforce\\depots\\1666\\depot\\main",
        "C:\\Users\\u\\.claude\\plugins\\cache\\kriswill\\capture-plan\\0.6.2",
        true,
      ),
    ).toBe(false)
  })
})
