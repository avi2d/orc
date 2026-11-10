import { afterEach, describe, expect, test } from "bun:test"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { standinScript } from "../../../packages/run/src/dispatch/heavy-standin"
import { noPueue, run, setup, type Harness } from "./heavy-standin-harness"

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

  test("an exported pueue group alone still queues the command", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "x"], { PUEUE_GROUP: "heavy" })
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("inside another pueue group the command still queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test"], { PUEUE_GROUP: "other", PUEUE_WORKER_ID: "0" })
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a heavy call inside a queued task runs directly instead of queueing behind the slot it holds", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const realBun = join(harness.root, "fake", "bun")
    const waiter = "sh -c 'o=$1; shift; \"$@\" & c=$!; wait \"$c\"' orc-heavy-wait 99 " + realBun + " test x"
    await writeFile(join(harness.root, "fake", "status.json"), JSON.stringify({ tasks: { 9: { id: 9, command: waiter, status: { Running: {} } } } }))
    await writeFile(
      join(harness.root, "fake", "pueue"),
      "#!/bin/sh\n" +
        'echo "pueue $*" >> "' + join(harness.root, "pueue.log") + '"\n' +
        'case "$1" in\n' +
        "  group) echo '{}';;\n" +
        "  add) echo 7;;\n" +
        "  log) printf '{\"7\":{\"status\":{\"Done\":{\"result\":\"Success\"}}}}';;\n" +
        "  follow) echo nested-output;;\n" +
        '  status) cat "' + join(harness.root, "fake", "status.json") + '";;\n' +
        "  remove|kill|wait) exit 0;;\n" +
        "esac\nexit 0\n",
      { mode: 0o755 }
    )
    await writeFile(
      join(harness.root, "fake", "ps"),
      "#!/bin/sh\n" +
        'p="$PPID"\n' +
        'q="$(/bin/ps -o ppid= -p "$p" 2>/dev/null | tr -d \' \')"\n' +
        'case "$q" in ""|*[!0-9]*) q="$p";; esac\n' +
        "w=$((q + 1000)); b=$((q + 2000)); d=$((q + 3000))\n" +
        "printf 'PID PPID COMMAND\\n'\n" +
        'printf \'%s %s /bin/sh ' + join(harness.bin, "bun") + ' test x\\n\' "$p" "$w"\n' +
        'if [ "$q" != "$p" ]; then printf \'%s %s /bin/sh ' + join(harness.bin, "bun") + ' test x\\n\' "$q" "$w"; fi\n' +
        "printf '%s %s " + realBun + " test x\\n' \"$w\" \"$b\"\n" +
        "printf '%s %s sh -c o=$1; shift; waiter-body orc-heavy-wait 99 " + realBun + " test x\\n' \"$b\" \"$d\"\n" +
        "printf '%s 1 pueued\\n' \"$d\"\n" +
        "printf '1 0 init\\n'\n",
      { mode: 0o755 }
    )
    const result = run(harness, "bun", ["test", "x"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("add --group heavy")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("bun test x")
  })

  test("a stand-in folder spelled with a trailing slash or doubled slashes runs the real tool instead of itself", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const rest = join(harness.root, "fake") + ":/usr/bin:/bin"
    for (const bin of [harness.bin + "/", harness.root + "//bin"]) {
      const child = Bun.spawnSync([join(harness.bin, "bun"), "--version"], {
        env: { ...harness.env, PATH: bin + ":" + rest },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 3_000
      })
      expect(child.exitCode).toBe(0)
    }
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("bun --version")
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
    const parsed: unknown = JSON.parse(line.trim())
    if (typeof parsed !== "object" || parsed === null || !("rule" in parsed) || !("reason" in parsed) || !("command" in parsed)) {
      throw new Error("the bypass log holds no bypass event")
    }
    const { rule, reason, command } = parsed
    if (typeof rule !== "string" || typeof reason !== "string" || typeof command !== "string") {
      throw new Error("the bypass event holds no rule, reason and command")
    }
    expect(rule).toBe("heavy-bypass")
    expect(reason).toBe("fix flaky seed")
    expect(command).toBe("bun test x")
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
    const deadline = Date.now() + 10_000
    while (!(await harness.pueueLog()).includes("log --json")) {
      if (Date.now() > deadline) {
        child.kill()
        throw new Error("the stand-in never reached its wait loop")
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    child.kill()
    expect(await child.exited).toBe(130)
    const log = await harness.pueueLog()
    expect(log).toMatch(/pueue (remove|kill) 7/)
  })

  test.skipIf(noPueue())(skipReason("needs a live pueue daemon", "a real pueue task runs the queued command and keeps its exit code"), async () => {
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
})
