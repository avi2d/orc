import { Data, Effect } from "effect"

class CompileDashboardError extends Data.TaggedError("CompileDashboardError")<{
  readonly message: string
}> {}

const root = Bun.fileURLToPath(new URL("..", import.meta.url))

export const dashboardTools = [
  { name: "orc-dash", directory: "packages/cli", entry: "bin.ts" },
  { name: "orc-dash-capture", directory: "packages/session-quota", entry: "capture-bin.ts" }
] as const

export const compileDashboardTool = (
  tool: typeof dashboardTools[number],
  outfile?: string
): Effect.Effect<void, CompileDashboardError> => {
  const directory = root + tool.directory
  return Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [directory + "/src/" + tool.entry],
        compile: { outfile: outfile ?? directory + "/dist/" + tool.name, autoloadDotenv: false, autoloadBunfig: false },
        bytecode: true,
        format: "esm",
        minify: true
      }),
    catch: (cause) => new CompileDashboardError({ message: String(cause) })
  }).pipe(
    Effect.flatMap((result) =>
      result.success
        ? Effect.void
        : Effect.fail(new CompileDashboardError({ message: result.logs.map((log) => log.message).join("\n") }))
    )
  )
}

const choose = (name: string | undefined): Effect.Effect<void, CompileDashboardError> => {
  const tool = dashboardTools.find((candidate) => candidate.name === name)
  return tool === undefined
    ? Effect.fail(
      new CompileDashboardError({
        message: "choose which command to compile: " + dashboardTools.map((candidate) => candidate.name).join(", ")
      })
    )
    : compileDashboardTool(tool)
}

if (import.meta.main) void Effect.runPromise(choose(process.argv[2]))
