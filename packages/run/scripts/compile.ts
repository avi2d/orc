const run = Bun.fileURLToPath(new URL("..", import.meta.url))
const chat = run + "src/features/chat/"

const tools = await Bun.build({ entrypoints: [chat + "chat-tools.ts"], target: "node", format: "esm" })

await Bun.build({
  entrypoints: [run + "src/bin.ts"],
  compile: { outfile: process.argv[2] ?? run + "dist/orc", autoloadDotenv: false, autoloadBunfig: false },
  bytecode: true,
  format: "esm",
  files: {
    [chat + "chat-tools-bundle.ts"]: "import file from \"./orc-chat-tools.js\" with { type: \"file\" }\nexport const chatToolsBundle: string | null = file\n",
    [chat + "orc-chat-tools.js"]: await tools.outputs[0].text()
  }
})
