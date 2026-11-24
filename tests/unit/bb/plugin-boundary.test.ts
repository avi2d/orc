import { expect, test } from "bun:test"
import { join, relative, resolve, sep } from "node:path"

const pluginDir = join(import.meta.dir, "../../../trials/bb/plugin")

const serverEntry = async (): Promise<string> => {
  const manifest: unknown = await Bun.file(join(pluginDir, "package.json")).json()
  const server = typeof manifest === "object" && manifest !== null && "bb" in manifest && typeof manifest.bb === "object" && manifest.bb !== null && "server" in manifest.bb ? manifest.bb.server : null
  if (typeof server !== "string") throw new Error("the plugin package.json names no bb.server entry")
  return join(pluginDir, server)
}

const outsidePlugin = (path: string): boolean => {
  const fromPlugin = relative(pluginDir, path)
  return fromPlugin === ".." || fromPlugin.startsWith(".." + sep)
}

test("the plugin server bundles no source from outside trials/bb/plugin, so bb's server build does not refuse it", async () => {
  const built = await Bun.build({ entrypoints: [await serverEntry()], target: "node", external: ["@get-bb/plugin-sdk"], metafile: true, throw: false })
  expect(built.logs.map(String)).toEqual([])
  const sources = Object.keys(built.metafile?.inputs ?? {})
    .map((input) => resolve(process.cwd(), input))
    .filter((path) => !path.split(sep).includes("node_modules"))
  expect(sources).toContain(join(pluginDir, "server.ts"))
  expect(sources.filter(outsidePlugin)).toEqual([])
})
