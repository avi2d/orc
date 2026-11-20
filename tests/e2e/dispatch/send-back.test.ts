import { expect, test } from "bun:test"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { insertStep, openDatabase, recordRun } from "../../../packages/run/src/entities/run-history/index"
import { binPath, fakeQuota, type Fixture, orcOk, runnerTimeout, withFixture } from "../runner-helpers"

const prUrl = "https://github.com/acme/orc/pull/8"

const captureRunQueue = async (fixture: Fixture) => {
  const program = join(fixture.dir, "bin", "pueue")
  await rename(program, program + "-base")
  // The detached start command writes this file while queuedRun polls it, so it is renamed into place whole rather than read empty after the shell creates it.
  await writeFile(program, '#!/bin/sh\nif [ "$1" = add ] && [ "$3" = orc ]; then printf "%s\\n" "$@" > "$PUEUE_STATE/run-args.tmp" && mv "$PUEUE_STATE/run-args.tmp" "$PUEUE_STATE/run-args"; fi\nexec "$0-base" "$@"\n')
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

const stubOpenPr = async (fixture: Fixture): Promise<void> => {
  const view = JSON.stringify({ state: "OPEN", headRefOid: "0123456789abcdef0123456789abcdef01234567", baseRefName: "main", statusCheckRollup: [] })
  await writeFile(join(fixture.dir, "bin", "gh"), "#!/bin/sh\nif [ \"$1 $2\" = \"pr view\" ]; then cat <<'J'\n" + view + "\nJ\nexit 0; fi\nexit 1\n")
  await chmod(join(fixture.dir, "bin", "gh"), 0o755)
}

const seedDoneRun = async (fixture: Fixture): Promise<void> => {
  const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
  try {
    Effect.runSync(recordRun(db, { id: "origin-run", project: fixture.checkout, branch: "orc/orc-1", taskFile: join(fixture.dir, "task.md"), status: "succeeded", started: "2026-11-02T10:00:05.000Z", ended: "2026-11-02T10:29:00.000Z", prLink: prUrl }))
    insertStep(db, { runId: "origin-run", name: "implement", attempt: 1, status: "passed", started: "2026-11-02T10:01:00.000Z", ended: "2026-11-02T10:19:00.000Z", agentFile: null, piSessionFile: null })
  } finally {
    db.close()
  }
}

const finishRun = (fixture: Fixture): Promise<void> =>
  writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {
    "77": { id: 77, label: fixture.home + " orc-1", group: "orc", path: fixture.checkout, status: { Done: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:30:00Z", result: "Success" } } }
  }, groups: {} }))

test("a task sent back twice restarts its run on orc/<id> with both reviews as answers, instead of starting fresh or keeping only the last", async () => {
  await withFixture(async (fixture) => {
    await fakeQuota(fixture)
    await captureRunQueue(fixture)
    await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 4, start: [process.execPath, binPath, "runner", "start"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1 on linux")
    const first = await queuedRun(fixture)
    expect(first).not.toContain("--answer")
    await rename(join(fixture.pueue, "run-args"), join(fixture.pueue, "first-args"))
    await seedDoneRun(fixture)
    await finishRun(fixture)
    await orcOk(fixture, ["beat"])
    expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")).toContain("pr: \"" + prUrl + "\"")
    await stubOpenPr(fixture)
    expect(await orcOk(fixture, ["backlog", "send-back", "orc-1", "rename", "the", "flag"])).toBe(
      "sent orc-1 back, so the next beat resumes run origin-run on orc/orc-1 with the review and its push updates " + prUrl + "\n"
    )
    const board: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
    expect(board).toMatchObject({ tasks: [{ id: "orc-1", status: "new", parked: { branch: "orc/orc-1", origin: { machine: "linux", run: "origin-run" } } }] })
    expect(await orcOk(fixture, ["backlog", "send-back", "orc-1", "and", "its", "help"])).toBe(
      "added the review to orc-1, so the next beat resumes run origin-run on orc/orc-1 with every review sent back\n"
    )
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1 on linux")
    const args = await queuedRun(fixture)
    expect(args).toContain("ORC_DISPATCH_RESUME_RUN=origin-run")
    expect(args.slice(args.indexOf("--branch"), args.indexOf("--branch") + 2)).toEqual(["--branch", "orc/orc-1"])
    expect(args.flatMap((arg, index) => args[index - 1] === "--answer" ? [arg] : [])).toEqual(["send-back=rename the flag", "send-back-2=and its help"])
  })
}, runnerTimeout)
