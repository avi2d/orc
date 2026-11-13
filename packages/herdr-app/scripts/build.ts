import { $ } from "bun"

const root = `${import.meta.dir}/..`
const out = process.argv[2] ?? `${root}/dist`
const appModules = ["gpui-kit", "gpui-base", "herdr"]

await $`rm -rf ${out}`

for await (const entry of new Bun.Glob("*/main.ts").scan({ cwd: `${root}/mods` })) {
  const mod = entry.slice(0, entry.indexOf("/"))
  const result = await Bun.build({
    entrypoints: [`${root}/mods/${entry}`],
    outdir: `${out}/mods/${mod}`,
    naming: "main.js",
    format: "esm",
    target: "browser",
    external: appModules
  })
  if (!result.success) {
    console.error(result.logs.map((log) => log.message).join("\n"))
    process.exitCode = 1
  }
  await $`cp ${root}/mods/${mod}/mod.json ${out}/mods/${mod}/mod.json`
}

await $`cp -R ${root}/layouts ${out}/layouts`
await $`cp ${root}/keys.json ${out}/keys.json`
