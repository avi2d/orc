const run = Bun.fileURLToPath(new URL("..", import.meta.url))
const outdir = run + "dist"
const placement = { outdir }
const results = await Promise.all([
  Bun.build({ entrypoints: [run + "src/bin.ts"], ...placement, target: "bun" }),
  Bun.build({ entrypoints: [run + "src/entities/heavy-queue/heavy-standin-main.ts"], ...placement, target: "bun", naming: "[name].ts" }),
  Bun.build({ entrypoints: [run + "src/features/chat/chat-tools.ts"], ...placement, target: "node", format: "esm", naming: "[name].ts" })
])

for (const result of results.filter((built) => !built.success)) {
  for (const log of result.logs) {
    process.stderr.write(log.message + "\n")
  }
  process.exitCode = 1
}
