#!/usr/bin/env bun
import { $ } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../packages/run/package.json" with { type: "json" }

const root = Bun.fileURLToPath(new URL("..", import.meta.url))
const out = process.argv[2] ?? join(root, "dist", "release-assets")
const archiveName = "orc-" + packageJson.version + "-" + process.platform + "-" + process.arch + ".tar.gz"
const archive = join(out, archiveName)

const stage = await mkdtemp(join(tmpdir(), "orc-release-assets-"))
try {
  await $`${process.execPath} ${join(root, "packages/run/scripts/compile.ts")} ${join(stage, "orc")}`
  await $`${process.execPath} ${join(root, "packages/herdr-app/scripts/build.ts")} ${join(stage, "herdr-app")}`
  await mkdir(out, { recursive: true })
  // macOS tar adds a ._ resource-fork file beside each file that carries extended attributes unless this is set.
  await $`tar -czf ${archive} -C ${stage} orc herdr-app`.env({ ...process.env, COPYFILE_DISABLE: "1" })
} finally {
  await rm(stage, { recursive: true, force: true })
}

const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
await Bun.write(archive + ".sha256", digest + "  " + archiveName + "\n")

console.log(archive)
console.log(archive + ".sha256")
