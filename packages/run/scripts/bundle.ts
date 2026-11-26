const run = Bun.fileURLToPath(new URL("..", import.meta.url))
const outdir = run + "dist"

// A bundled module resolves import.meta against dist, so chat.ts and heavy-standin-runtime.ts look there for these files under their source names.
const results = await Promise.all([
  Bun.build({ entrypoints: [run + "src/bin.ts"], outdir, target: "bun" }),
  Bun.build({ entrypoints: [run + "src/entities/heavy-queue/heavy-standin-main.ts"], outdir, target: "bun", naming: "[name].ts" }),
  Bun.build({ entrypoints: [run + "src/features/chat/chat-tools.ts"], outdir, target: "node", format: "esm", naming: "[name].ts" })
])

for (const result of results.filter((built) => !built.success)) {
  for (const log of result.logs) {
    process.stderr.write(log.message + "\n")
  }
  process.exitCode = 1
}
