// Bun matches a files key against the resolved module path, which holds backslashes on Windows.
const separator = process.platform === "win32" ? "\\" : "/"
const at = (...parts: ReadonlyArray<string>): string => parts.join(separator)

const run = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")
const chat = at(run, "src", "features", "chat")

const tools = await Bun.build({ entrypoints: [at(chat, "chat-tools.ts")], target: "node", format: "esm" })

await Bun.build({
  entrypoints: [at(run, "src", "bin.ts")],
  compile: { outfile: at(run, "dist", "orc") },
  bytecode: true,
  format: "esm",
  files: {
    [at(chat, "chat-tools-bundle.ts")]: "import file from \"./orc-chat-tools.js\" with { type: \"file\" }\nexport const chatToolsBundle: string | null = file\n",
    [at(chat, "orc-chat-tools.js")]: await tools.outputs[0].text()
  }
})
