import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { assetPath } from "../../packages/run/src/entities/agent/asset-path"

describe("assetPath", () => {
  test.each([
    "B:\\~BUN\\root\\implementer-hash.md",
    "B:/~BUN/root/implementer-hash.md",
    "C:\\checkout\\agents\\implementer.md",
    "/$bunfs/root/implementer-hash.md",
    "/checkout/a#b/agents/implementer.md",
    "/checkout/a?b/agents/implementer.md",
    "/checkout/a%b/agents/implementer.md"
  ])("preserves the absolute asset path %s instead of interpreting it as a URL", (file) => {
    expect(assetPath(file)).toBe(file)
  })

  test("resolves bundle-relative assets beside the module instead of the working directory", () => {
    const directory = fileURLToPath(new URL("../../packages/run/src/entities/agent/", import.meta.url))
    expect(assetPath("./implementer-hash.md")).toBe(join(directory, "implementer-hash.md"))
  })

  test("loads the Node-target bundle without a Bun global", async () => {
    const scratch = fileURLToPath(new URL("../../.orc-home/", import.meta.url))
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, "asset-path-"))
    try {
      const outdir = join(root, "bundle # %")
      const result = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../../packages/run/src/entities/agent/asset-path.ts", import.meta.url))],
        outdir,
        target: "node",
        format: "esm",
        naming: "[name].mjs"
      })
      expect(result.success).toBe(true)
      const program = [
        'const { assetPath } = await import(process.argv[1])',
        'console.log(assetPath("./implementer-hash.md"))',
        'console.log(assetPath("C:\\\\checkout\\\\agents\\\\implementer.md"))'
      ].join("\n")
      const proc = Bun.spawnSync(["node", "--input-type=module", "--eval", program, pathToFileURL(join(outdir, "asset-path.mjs")).href], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe"
      })
      expect(proc.stderr.toString()).toBe("")
      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString().trim().split(/\r?\n/)).toEqual([
        join(outdir, "implementer-hash.md"),
        "C:\\checkout\\agents\\implementer.md"
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
