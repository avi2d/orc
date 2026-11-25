import { join } from "node:path"

const run = Bun.fileURLToPath(new URL("..", import.meta.url))
const chat = join(run, "src", "features", "chat")

const tools = await Bun.build({ entrypoints: [join(chat, "chat-tools.ts")], target: "node", format: "esm" })

await Bun.build({
  entrypoints: [join(run, "src", "bin.ts")],
  compile: { outfile: join(run, "dist", "orc") },
  bytecode: true,
  format: "esm",
  files: {
    [join(chat, "chat-tools-bundle.ts")]: "import file from \"./orc-chat-tools.js\" with { type: \"file\" }\nexport const chatToolsBundle: string | null = file\n",
    [join(chat, "orc-chat-tools.js")]: await tools.outputs[0].text()
  }
})
