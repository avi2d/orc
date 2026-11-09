import { afterEach, describe, expect, test } from "bun:test"

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
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

interface Harness {
  readonly root: string
  readonly bin: string
  readonly env: Record<string, string>
  readonly pueueLog: () => Promise<string>
}

const settingsOf = (home: string) => ({ home, group: "heavy", wrap: "" })

const setup = async (tools: ReadonlyArray<string>, commands: ReadonlyArray<string> = [], timing?: StandinTiming): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "orc-heavy-"))
  const bin = join(root, "bin")
  const fake = join(root, "fake")
  await mkdir(bin, { recursive: true })
  await mkdir(fake, { recursive: true })
  await writeFile(join(fake, "pueue"), fakePueue, { mode: 0o755 })
  await writeFile(join(fake, "bun"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "mytool"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "vitest"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "npm"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "go"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "jest"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "eslint"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "tsc"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "npx"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "xcodebuild"), fakeTool, { mode: 0o755 })
  await writeFile(join(fake, "xcrun"), fakeTool, { mode: 0o755 })
  for (const tool of tools) {
    await writeFile(join(fake, tool), fakeTool, { mode: 0o755 })
    await writeFile(join(bin, tool), standinScript(tool, settingsOf(root), commands, timing), { mode: 0o755 })
  }
  const env: Record<string, string> = {
    PATH: bin + ":" + fake + ":/usr/bin:/bin",
    FAKE_PUEUE_LOG: join(root, "pueue.log"),
    FAKE_TOOL_LOG: join(root, "tool.log"),
    FAKE_LOG_JSON: '{"7":{"status":{"Done":{"result":"Success"}}}}',
    FAKE_FOLLOW_OUTPUT: ""
  }
  return { root, bin, env, pueueLog: () => readFile(join(root, "pueue.log"), "utf8").catch(() => "") }
}

const noPueue = (): boolean => {
  try {
    return Bun.spawnSync(["pueue", "status", "--json"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0
  } catch {
    return true
  }
}

const run = (harness: Harness, tool: string, args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } => {
  const child = Bun.spawnSync([join(harness.bin, tool), ...args], {
    env: { ...harness.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe"
  })
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

let harnesses: Array<Harness> = []

afterEach(async () => {
  for (const harness of harnesses) {
    await rm(harness.root, { recursive: true, force: true })
  }
  harnesses = []
})

describe("the heavy stand-in", () => {
  test("bun test on a named test file becomes a pueue task in the heavy group with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "login.test.ts"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy -o 1")
    expect(log).toContain("--print-task-id")
    expect(log).toContain("--escape")
  })

  test("a whole bun test run queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("inside pueue the command runs directly", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "x"], { PUEUE_GROUP: "heavy" })
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("inside another pueue group the command still queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test"], { PUEUE_GROUP: "other", PUEUE_WORKER_ID: "0" })
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("the queued command output reaches the caller", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test"], { FAKE_FOLLOW_OUTPUT: "hello-from-the-queue" })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("hello-from-the-queue")
  })

  test("a bypass runs directly and logs a valid event for the command", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "x"], { HEAVY_QUEUE_BYPASS: 'fix "flaky"\\ seed' })
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    const line = await readFile(join(harness.root, "backlog", "alerts.jsonl"), "utf8")
    const event = JSON.parse(line.trim()) as { rule: string; reason: string; command: string }
    expect(event.rule).toBe("heavy-bypass")
    expect(event.reason).toBe("fix flaky seed")
    expect(event.command).toBe("bun test x")
  })

  test("bun x runs a heavy tool through the queue", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["x", "vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("bun run finds the script past option flags", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "--filter", "proj", "build"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("npm test queues and npm install never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const queued = run(harness, "npm", ["test"])
    expect(queued.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
    const direct = run(harness, "npm", ["install"])
    expect(direct.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("install")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("npm install")
  })

  test("bun install never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["install"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a failing queued command keeps its exit code", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const failing = { ...harness.env, FAKE_TOOL_EXIT: "3", FAKE_LOG_JSON: '{"7":{"status":{"Done":{"result":{"Failed":3}}}}}' }
    const result = run({ ...harness, env: failing }, "bun", ["test", "x"])
    expect(result.code).toBe(3)
  })

  test("an interrupt while waiting removes the task and leaves nothing behind", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const child = Bun.spawn([join(harness.bin, "bun"), "test", "x"], {
      env: { ...harness.env, FAKE_LOG_JSON: '{"7":{"status":{"Running":{}}}}' },
      stdout: "ignore",
      stderr: "pipe"
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    child.kill()
    expect(await child.exited).toBe(130)
    const log = await harness.pueueLog()
    expect(log).toMatch(/pueue (remove|kill) 7/)
  })

  test.skipIf(noPueue())("a real pueue task runs the queued command and keeps its exit code", async () => {
    const group = "orc-heavy-test"
    Bun.spawnSync(["pueue", "group", "add", group, "--parallel", "1"], { stdout: "ignore", stderr: "ignore" })
    try {
      const root = await mkdtemp(join(tmpdir(), "orc-heavy-real-"))
      harnesses.push({ root, bin: "", env: {}, pueueLog: async () => "" })
      const bin = join(root, "bin")
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, "bun"), standinScript("bun", { home: root, group, wrap: "" }, []), { mode: 0o755 })
      await writeFile(join(root, "pass.test.ts"), 'test("x", () => {})\n')
      await writeFile(join(root, "fail.test.ts"), 'test("x", () => { throw new Error("x") })\n')
      const realEnv = { ...process.env, PATH: bin + ":" + process.env.PATH, HOME: userInfo().homedir }
      const passed = Bun.spawnSync([join(bin, "bun"), "test", "pass.test.ts"], { cwd: root, env: realEnv, stdout: "ignore", stderr: "ignore" })
      expect(passed.exitCode).toBe(0)
      const failed = Bun.spawnSync([join(bin, "bun"), "test", "fail.test.ts"], { cwd: root, env: realEnv, stdout: "ignore", stderr: "ignore" })
      expect(failed.exitCode).toBe(1)
      await rm(root, { recursive: true, force: true })
    } finally {
      Bun.spawnSync(["pueue", "clean", "--group", group], { stdout: "ignore", stderr: "ignore" })
      Bun.spawnSync(["pueue", "group", "remove", group], { stdout: "ignore", stderr: "ignore" })
    }
  })

  test("a wait past the budget fails the step with a queue message", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"], [], { budgetMinutes: 0, pollSeconds: 1 })) - 1]
    const result = run(harness, "bun", ["test", "x"], { FAKE_LOG_JSON: '{"7":{"status":{"Queued":{}}}}' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("waited 0 min for the heavy queue")
    expect(await harness.pueueLog()).toContain("pueue remove 7")
  })
  test("bun test on a bare word queues with priority instead of waiting behind whole suites", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "x"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("bun test with a filter queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "-t", "login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("bun test with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "--timeout", "20000"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("vitest run with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["run", "--reporter", "verbose"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("jest with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["jest"])) - 1]
    const result = run(harness, "jest", ["--maxWorkers", "2"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("tsc with a project path queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["tsc"])) - 1]
    const result = run(harness, "tsc", ["-p", "packages/x/tsconfig.json"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("go build with an output path keeps priority on the package", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["build", "-o", "bin/app", "./cmd/app"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("pnpm runs a heavy bin through the queue", async () => {
    const harness = harnesses[harnesses.push(await setup(["pnpm"])) - 1]
    const result = run(harness, "pnpm", ["vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("bun runs a heavy bin directly", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("bun run queues build and lint scripts", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const build = run(harness, "bun", ["run", "build:ci"])
    expect(build.code).toBe(0)
    const lint = run(harness, "bun", ["run", "lint:fix"])
    expect(lint.code).toBe(0)
    const tsc = run(harness, "bun", ["run", "tsc"])
    expect(tsc.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log.match(/add --group heavy/g)?.length).toBe(3)
  })

  test("classify names the queue decision without queueing", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun", "npm", "go"])) - 1]
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(run(harness, "bun", ["test", "x"], classify).stdout.trim()).toBe("1 1")
    expect(run(harness, "bun", ["test", "--timeout", "20000"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "bun", ["run", "dev"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "npm", ["install"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "go", ["test", "-timeout", "10m", "./..."], classify).stdout.trim()).toBe("1 0")
    expect(await harness.pueueLog()).toBe("")
  })

  test("bun x on a named test file queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["x", "vitest", "login.test.ts"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("bun run dev never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "dev"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("bun run dev")
  })

  test("bun run test:ui never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "test:ui"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a bun test watch run never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "--watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("go test queues with priority on a named package", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "./pkg/foo"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("a whole go test run queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "./..."])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("go vet queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["vet", "./..."])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("go test with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "-timeout", "10m", "./..."])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("-o 1")
  })

  test("go version never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["version"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("go version")
  })

  test("vitest run queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["run"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("vitest on a bare word queues with priority instead of waiting behind whole suites", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("vitest watch never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("jest on a bare word queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["jest"])) - 1]
    const result = run(harness, "jest", ["login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("eslint on a bare folder queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["eslint"])) - 1]
    const result = run(harness, "eslint", ["src"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("tsc with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["tsc"])) - 1]
    const result = run(harness, "tsc", ["-p", "tsconfig.json"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("-o 1")
  })

  test("npm run test with a filter queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["run", "test", "--", "-t", "login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("npm run test:watch never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["run", "test:watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("npx runs a heavy tool through the queue", async () => {
    const harness = harnesses[harnesses.push(await setup(["npx"])) - 1]
    const result = run(harness, "npx", ["vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a machine command queues under its first word", async () => {
    const harness = harnesses[harnesses.push(await setup(["checks-test"], ["checks-test"])) - 1]
    const result = run(harness, "checks-test", ["--changed"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("an unknown tool never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["mytool"])) - 1]
    const result = run(harness, "mytool", ["foo"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("mytool foo")
  })

  test("xcodebuild queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["xcodebuild"])) - 1]
    const result = run(harness, "xcodebuild", ["-scheme", "App"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("xcrun simctl boot queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["xcrun"])) - 1]
    const result = run(harness, "xcrun", ["simctl", "boot", "uuid"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

})
