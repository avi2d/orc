import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { standinScript, type StandinTiming } from "../../../packages/run/src/dispatch/heavy-standin"

const fakePueue = `#!/bin/sh
echo "pueue $*" >> "$FAKE_PUEUE_LOG"
case "$1" in
  group) echo '{}';;
  add) echo 7;;
  wait) sleep "\${FAKE_WAIT_SECS:-0.2}";;
  log) printf '%s' "$FAKE_LOG_JSON";;
  follow) printf '%s' "$FAKE_FOLLOW_OUTPUT";;
  status) echo "7 | Queued | fake command";;
  remove|kill) exit 0;;
esac
exit 0
`

const fakeTool = `#!/bin/sh
echo "real $0 $*" >> "$FAKE_TOOL_LOG"
exit "\${FAKE_TOOL_EXIT:-0}"
`

export interface Harness {
  readonly root: string
  readonly bin: string
  readonly env: Record<string, string>
  readonly pueueLog: () => Promise<string>
}

const settingsOf = (home: string) => ({ home, group: "heavy", wrap: "" })

const staticFakes: ReadonlyArray<string> = ["pueue", "bun", "mytool", "vitest", "npm", "go", "jest", "eslint", "tsc", "npx", "xcodebuild", "xcrun"]

const makeDirs = async (root: string): Promise<{ bin: string; fake: string }> => {
  const bin = join(root, "bin")
  const fake = join(root, "fake")
  await mkdir(bin, { recursive: true })
  await mkdir(fake, { recursive: true })
  return { bin, fake }
}

const writeStaticFakes = async (fake: string): Promise<void> => {
  for (const name of staticFakes) {
    await writeFile(join(fake, name), name === "pueue" ? fakePueue : fakeTool, { mode: 0o755 })
  }
}

const writeToolStandins = async (bin: string, root: string, fake: string, tools: ReadonlyArray<string>, commands: ReadonlyArray<string>, timing?: StandinTiming): Promise<void> => {
  for (const tool of tools) {
    await writeFile(join(fake, tool), fakeTool, { mode: 0o755 })
    await writeFile(join(bin, tool), standinScript(tool, settingsOf(root), commands, timing), { mode: 0o755 })
  }
}

const harnessEnv = (root: string, bin: string, fake: string): Record<string, string> => ({
  PATH: bin + ":" + fake + ":/usr/bin:/bin",
  FAKE_PUEUE_LOG: join(root, "pueue.log"),
  FAKE_TOOL_LOG: join(root, "tool.log"),
  FAKE_LOG_JSON: '{"7":{"status":{"Done":{"result":"Success"}}}}',
  FAKE_FOLLOW_OUTPUT: ""
})

export const setup = async (tools: ReadonlyArray<string>, commands: ReadonlyArray<string> = [], timing?: StandinTiming): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "orc-heavy-"))
  const { bin, fake } = await makeDirs(root)
  await writeStaticFakes(fake)
  await writeToolStandins(bin, root, fake, tools, commands, timing)
  const env = harnessEnv(root, bin, fake)
  return { root, bin, env, pueueLog: () => readFile(join(root, "pueue.log"), "utf8").catch(() => "") }
}

export const noPueue = (): boolean => {
  try {
    return Bun.spawnSync(["pueue", "status", "--json"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0
  } catch {
    return true
  }
}

export const run = (harness: Harness, tool: string, args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } => {
  const child = Bun.spawnSync([join(harness.bin, tool), ...args], {
    env: { ...harness.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe"
  })
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}
