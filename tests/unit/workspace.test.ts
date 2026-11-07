import { describe, expect, test } from "bun:test"
import rootManifest from "../../package.json" with { type: "json" }
import runManifest from "../../packages/run/package.json" with { type: "json" }

const sharedDependencies = ["@effect/platform-bun", "effect"] as const

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

  test("no package keeps the retired tui-dash scope instead of moving to the orc name", async () => {
    const root = new URL("../..", import.meta.url).pathname
    const names: Array<string> = []
    for await (const path of new Bun.Glob("packages/*/package.json").scan({ cwd: root })) {
      if (path === "packages/run/package.json") {
        continue
      }
      const manifest: unknown = await Bun.file(`${root}/${path}`).json()
      if (typeof manifest !== "object" || manifest === null || !("name" in manifest)) {
        throw new Error(`Package manifest holds no name: ${path}`)
      }
      if (typeof manifest.name !== "string") {
        throw new Error(`Package name is not a string: ${path}`)
      }
      names.push(manifest.name)
      expect(manifest.name).toBe(`@avi2dg/orc-${path.split("/")[1]}`)
    }
    expect(names.length).toBe(13)
  })

  test("the root tooling resolves the same dependency copies the run package ships instead of loading them twice", () => {
    for (const name of sharedDependencies) {
      expect(Bun.resolveSync(name, new URL("../..", import.meta.url).pathname)).toBe(
        Bun.resolveSync(name, new URL("../../packages/run/", import.meta.url).pathname)
      )
    }
  })
})
