import { spawn } from "bun"

const [checkout, mode, task] = process.argv.slice(2)
if (!checkout || !task || (mode !== "snapshot" && mode !== "overview")) {
  console.error("usage: bun scripts/bench-app-reads.ts CHECKOUT snapshot|overview TASK_ID")
  process.exitCode = 2
} else {

  const commands = [
    ["run", "backlog", "thread", task, "--json"],
    ["run", "backlog", "--json"],
    mode === "snapshot" ? ["cli", "snapshot", "--json", "--only", "quota"] : ["cli", "report", "subscription-overview"],
    mode === "snapshot" ? ["cli", "snapshot", "--json", "--only", "resources,queues"] : ["cli", "report", "machine-overview"],
  ]

  for (const [pkg, ...args] of commands) {
    const start = performance.now()
    const proc = spawn([process.execPath, `${checkout}/packages/${pkg}/src/bin.ts`, ...args], { stdout: "pipe", stderr: "inherit" })
    const parts: Array<Uint8Array<ArrayBuffer>> = []
    let first: number | null = null
    for await (const part of proc.stdout) {
      first ??= performance.now()
      parts.push(part)
    }
    if (await proc.exited !== 0 || first === null) {
      console.error(args.join(" ") + " returned no report")
      process.exitCode = 1
      break
    }
    const elapsed = performance.now() - start
    const output = new Blob(parts)
    const text = await output.text()
    const parse = performance.now()
    JSON.parse(text)
    console.log(JSON.stringify({ command: args.join(" "), firstMs: first - start, totalMs: elapsed, bytes: output.size, bunParseMs: performance.now() - parse }))
  }
}
