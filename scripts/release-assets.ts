#!/usr/bin/env bun
import { $ } from "bun"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import packageJson from "../packages/run/package.json" with { type: "json" }
import { compileDashboardTool, dashboardTools } from "./compile-dashboard"

const root = Bun.fileURLToPath(new URL("..", import.meta.url))
const out = (process.argv[2] ?? root + "release-assets").replace(/\/+$/, "")
const platform = process.platform + "-" + process.arch
const binaryName = "orc-" + platform
const archiveName = "orc-" + packageJson.version + "-" + platform + ".tar.gz"
const binary = out + "/" + binaryName
const archive = out + "/" + archiveName

const stage = (await $`mktemp -d ${tmpdir() + "/orc-release-assets-XXXXXX"}`.text()).trim()
try {
  const orc = stage + "/orc"
  await $`${process.execPath} ${root + "packages/run/scripts/compile.ts"} ${orc}`
  await $`${process.execPath} ${root + "packages/run/scripts/build-heavy-standin.ts"} ${stage + "/heavy-standin"}`
  await $`${process.execPath} ${root + "packages/herdr-app/scripts/build.ts"} ${stage + "/herdr-app"}`
  for (const tool of dashboardTools) {
    const executable = stage + "/" + tool.name
    await Effect.runPromise(compileDashboardTool(tool, executable))
    const help = await $`${executable} --help`.env({ ...process.env, PATH: stage }).text()
    process.stderr.write(help)
  }
  await $`mkdir -p ${out}`
  await $`cp ${orc} ${binary}`
  // macOS tar adds a ._ resource-fork file beside each file that carries extended attributes unless this is set.
  await $`tar -czf ${archive} -C ${stage} orc heavy-standin herdr-app ${dashboardTools.map(({ name }) => name)}`.env({ ...process.env, COPYFILE_DISABLE: "1" })
} finally {
  await $`rm -rf ${stage}`
}

for (const name of [binaryName, archiveName]) {
  const file = out + "/" + name
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
  await Bun.write(file + ".sha256", digest + "  " + name + "\n")
  console.log(file)
  console.log(file + ".sha256")
}
