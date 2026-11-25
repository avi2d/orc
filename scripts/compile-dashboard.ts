const root = Bun.fileURLToPath(new URL("..", import.meta.url))

export const dashboardTools = [
  { name: "orc-dash", directory: "packages/cli", entry: "bin.ts" },
  { name: "orc-dash-capture", directory: "packages/session-quota", entry: "capture-bin.ts" }
] as const

export const compileDashboardTool = async (tool: typeof dashboardTools[number], outfile?: string): Promise<void> => {
  const directory = root + tool.directory
  const result = await Bun.build({
    entrypoints: [directory + "/src/" + tool.entry],
    compile: { outfile: outfile ?? directory + "/dist/" + tool.name, autoloadDotenv: false, autoloadBunfig: false },
    bytecode: true,
    format: "esm",
    minify: true
  })
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"))
  }
}

if (import.meta.main) {
  const tool = dashboardTools.find(({ name }) => name === process.argv[2])
  if (tool === undefined) {
    throw new Error("choose which command to compile: " + dashboardTools.map(({ name }) => name).join(", "))
  }
  await compileDashboardTool(tool, process.argv[3])
}
