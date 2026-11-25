const run = new URL("..", import.meta.url)
const at = (path: string): string => Bun.fileURLToPath(new URL(path, run))

const tools = await Bun.build({ entrypoints: [at("src/features/chat/chat-tools.ts")], target: "node", format: "esm" })

await Bun.build({
  entrypoints: [at("src/bin.ts")],
  compile: { outfile: process.argv[2] ?? at("dist/orc") },
  bytecode: true,
  format: "esm",
  files: {
    [at("src/features/chat/chat-tools-bundle.ts")]: "import file from \"./orc-chat-tools.js\" with { type: \"file\" }\nexport const chatToolsBundle: string | null = file\n",
    [at("src/features/chat/orc-chat-tools.js")]: await tools.outputs[0].text()
  }
})
