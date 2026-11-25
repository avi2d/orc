const entry = import.meta.dir + "/../src/entities/heavy-queue/heavy-standin-main.ts"
const outfile = process.argv[2] ?? import.meta.dir + "/../dist/heavy-standin"

// Bytecode builds default to CommonJS, which cannot hold the entry's top-level await.
const result = await Bun.build({
  entrypoints: [entry],
  compile: { outfile, autoloadDotenv: false, autoloadBunfig: false },
  bytecode: true,
  format: "esm",
  minify: true
})

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(log.message + "\n")
  }
  process.exitCode = 1
}
