import { expect, test } from "bun:test"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { insertSignal, insertStep, openDatabase, recordRun } from "../../../packages/run/src/entities/run-history/index"
import { binPath, fakeQuota, type Fixture, orcOk, runOrc, runnerTimeout, withFixture } from "../runner-helpers"

const captureRunQueue = async (fixture: Fixture) => {
  const program = join(fixture.dir, "bin", "pueue")
  await rename(program, program + "-base")
  await writeFile(program, '#!/bin/sh\nif [ "$1" = add ] && [ "$3" = orc ]; then printf "%s\\n" "$@" > "$PUEUE_STATE/run-args"; fi\nexec "$0-base" "$@"\n')
  await chmod(program, 0o755)
}

const queuedRun = async (fixture: Fixture) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = await readFile(join(fixture.pueue, "run-args"), "utf8").catch(() => null)
    if (text !== null) {
      return text.split("\n").slice(0, -1)
    }
    await Bun.sleep(20)
  }
  throw new Error("no run reached the machine's queue")
}

test("an answered parked task cannot move to a roomier machine or start fresh without its original run", async () => {
  await withFixture(async (local) => withFixture(async (remote) => {
    await fakeQuota(local)
    await captureRunQueue(local)
    await captureRunQueue(remote)
    await writeFile(join(local.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
    await writeFile(join(remote.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
    const through = ["env", "ORC_HOME=" + remote.home, "PUEUE_STATE=" + remote.pueue, "PATH=" + remote.env.PATH, process.execPath, binPath]
    const localMachine = { name: "linux", slots: 4, start: [process.execPath, binPath, "runner", "start"] }
    const remoteMachine = { name: "winbox", slots: 1, start: [process.execPath, binPath, "runner", "start", "--", ...through] }
    const dispatch = async (machines: ReadonlyArray<typeof localMachine>) => {
      await writeFile(join(local.home, "backlog", "dispatch.json"), JSON.stringify({
        machines, quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
      }))
      await writeFile(join(local.home, "backlog", "projects.json"), JSON.stringify({ projects: [{
        name: "orc", checkouts: Object.fromEntries(machines.map((machine) => [machine.name, machine.name === "linux" ? local.checkout : remote.checkout]))
      }] }))
    }
    await dispatch([{ ...localMachine, slots: 0 }, remoteMachine])
    await orcOk(local, ["backlog", "add", "orc", "task.md"])
    expect(await orcOk(local, ["beat"])).toContain("started orc-1 on winbox")
    await queuedRun(remote)
    await rename(join(remote.pueue, "run-args"), join(remote.pueue, "original-args"))
    const savedTask = join(remote.dir, "saved-task.md")
    const body = await readFile(join(local.dir, "task.md"), "utf8")
    await writeFile(savedTask, body)
    const db = await Effect.runPromise(openDatabase(remote.home).pipe(Effect.provide(BunServices.layer)))
    try {
      Effect.runSync(recordRun(db, { id: "origin-run", project: remote.checkout, branch: "orc/orc-1", taskFile: savedTask, status: "failed", started: "2026-11-02T10:00:05.000Z", ended: "2026-11-02T10:29:00.000Z" }))
      insertStep(db, { runId: "origin-run", name: "implement", attempt: 1, status: "passed", started: "2026-11-02T10:01:00.000Z", ended: "2026-11-02T10:19:00.000Z", agentFile: null, piSessionFile: null })
      const step = insertStep(db, { runId: "origin-run", name: "no-mistakes", attempt: 1, status: "failed", started: "2026-11-02T10:20:00.000Z", ended: "2026-11-02T10:29:00.000Z", agentFile: null, piSessionFile: null })
      insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify({ id: "R1", text: "Keep the output contract?" }) })
    } finally {
      db.close()
    }
    await writeFile(join(remote.pueue, "status.json"), JSON.stringify({ tasks: {
      "77": { id: 77, label: local.home + " orc-1", group: "orc", path: remote.checkout, status: { Done: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:30:00Z", result: { Failed: 1 } } } }
    }, groups: {} }))
    expect(await orcOk(local, ["beat"])).toContain("parked orc-1")
    await orcOk(local, ["backlog", "answer", "orc-1", "R1=Keep it"])
    await dispatch([localMachine])
    expect(await orcOk(local, ["beat"])).toContain("waits orc-1: the machine winbox is not in dispatch.json")
    const board: unknown = JSON.parse(await orcOk(local, ["backlog", "--json"]))
    expect(board).toMatchObject({ tasks: [{ id: "orc-1", status: "new", machine: null, parked: { origin: { machine: "winbox", run: "origin-run" } } }] })
    await dispatch([localMachine, { ...remoteMachine, slots: 0 }])
    expect(await orcOk(local, ["beat"])).toContain("waits orc-1: winbox has no room")
    await dispatch([localMachine, remoteMachine])
    const taskFile = join(local.home, "backlog", "new", "orc-1.md")
    const parked = await readFile(taskFile, "utf8")
    await writeFile(taskFile, parked.replace(/^parked_origin: .+\n/m, ""))
    const legacy: unknown = JSON.parse(await orcOk(local, ["backlog", "--json"]))
    expect(legacy).toMatchObject({ tasks: [{ id: "orc-1", status: "new", wait: "the parked task has no recorded machine and run; recover its origin before resuming" }] })
    expect(await orcOk(local, ["beat"])).toContain("waits orc-1: the parked task has no recorded machine and run")
    await writeFile(taskFile, parked)
    const history = await Effect.runPromise(openDatabase(remote.home).pipe(Effect.provide(BunServices.layer)))
    try {
      history.query("UPDATE runs SET project = ? WHERE id = ?").run(remote.checkout + "-unavailable", "origin-run")
      expect(await orcOk(local, ["beat"])).toContain("waits orc-1: parked run origin-run is unavailable on winbox")
      expect(await readFile(join(remote.pueue, "run-args"), "utf8").catch(() => null)).toBeNull()
      history.query("UPDATE runs SET project = ? WHERE id = ?").run(remote.checkout, "origin-run")
    } finally {
      history.close()
    }
    expect(await orcOk(local, ["beat"])).toContain("started orc-1 on winbox")
    const args = await queuedRun(remote)
    expect(args).toContain("ORC_DISPATCH_RESUME_RUN=origin-run")
    expect(args.slice(args.indexOf("--branch"), args.indexOf("--branch") + 2)).toEqual(["--branch", "orc/orc-1"])
    expect(args.slice(args.indexOf("--answer"), args.indexOf("--answer") + 2)).toEqual(["--answer", "R1=Keep it"])
    expect(await readFile(join(local.pueue, "run-args"), "utf8").catch(() => null)).toBeNull()
    expect(await readFile(savedTask, "utf8")).toBe(body)
  }))
}, runnerTimeout)

test("runner queue refuses a missing pinned run instead of silently launching fresh implementation", async () => {
  await withFixture(async (fixture) => {
    await captureRunQueue(fixture)
    const queued = await runOrc(fixture, ["runner", "queue"], {}, JSON.stringify({
      task: "orc-1", checkout: fixture.checkout, provider: "acme", body: "# Original intent\n",
      branch: "orc/orc-1", resumeRun: "missing-run"
    }))
    expect(queued.exitCode).toBe(1)
    expect(queued.stderr).toContain("cannot resume missing-run")
    expect(await readFile(join(fixture.pueue, "run-args"), "utf8").catch(() => null)).toBeNull()
  })
}, runnerTimeout)
