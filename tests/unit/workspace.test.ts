import { describe, expect, test } from "bun:test"
import rootManifest from "../../package.json" with { type: "json" }
import runManifest from "../../packages/run/package.json" with { type: "json" }

const sharedDependencies = ["@ai-hero/sandcastle", "@effect/platform-bun", "effect"] as const

describe("the orc workspace", () => {
  test("the run package keeps the scoped name instead of the taken orc name", () => {
    expect(runManifest.name).toBe("@avi2dg/orc")
  })

  test("the run package version matches the workspace root instead of drifting from the release it tags", () => {
    expect(runManifest.version).toBe(rootManifest.version)
  })

  test("the root dev dependencies match the run package instead of splitting the install", () => {
    for (const name of sharedDependencies) {
      expect(rootManifest.devDependencies[name]).toBe(runManifest.dependencies[name])
    }
  })

  test("the root tooling resolves the same dependency copies the run package ships instead of loading them twice", () => {
    for (const name of sharedDependencies) {
      expect(Bun.resolveSync(name, new URL("../..", import.meta.url).pathname)).toBe(
        Bun.resolveSync(name, new URL("../../packages/run/", import.meta.url).pathname)
      )
    }
  })
})
