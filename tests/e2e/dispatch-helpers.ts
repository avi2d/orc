import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const beatTimeout = 120_000

export const binPath = new URL("../../packages/run/dist/bin.js", import.meta.url).pathname

const quotaStatus = {
  schema: "orc.quota.v1",
  accounts: [{ name: "main", remainingPercent: 40 }, { name: "second", remainingPercent: 80 }]
}

const accounts = [{ name: "main", tokenFile: "/secrets/main-token" }, { name: "second", tokenFile: "/secrets/second-token" }]

interface QuotaConfig {
  readonly provider: string
  readonly command: ReadonlyArray<string>
  readonly accounts: typeof accounts
  readonly floorPercent: number
}

export const quotaConfig = (floorPercent: number): QuotaConfig => ({ provider: "acme", command: ["orc-quota", "--json"], accounts, floorPercent })

export interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
  readonly arrivals: string
  readonly startLog: string
}

export const runOrc = async (
  fixture: Fixture,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin: string | null = null
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ...fixture.env, ...env }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

export const orcOk = async (fixture: Fixture, args: ReadonlyArray<string>, env: Record<string, string> = {}): Promise<string> => {
  const result = await runOrc(fixture, args, env)
  if (result.exitCode !== 0) {
    throw new Error("orc " + args.join(" ") + " exited " + result.exitCode + ": " + result.stderr)
  }
  return result.stdout
}

const fakeQuota = (arrivals: string): string =>
  [
    "#!/bin/sh",
    "[ \"$1\" = --json ] || exit 3",
    "touch '" + arrivals + "'/$$",
    "while [ \"$(ls '" + arrivals + "' | wc -l)\" -lt \"${QUOTA_AWAITS:-0}\" ]; do sleep 0.01; done",
    "cat <<'J'",
    JSON.stringify(quotaStatus),
    "J",
    ""
  ].join("\n")

interface FixtureShape {
  readonly mac: number
  readonly linux: number
  readonly floorPercent: number
}

export const withFixture = async (shape: FixtureShape, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-dispatch-e2e-"))
  try {
    const bin = join(dir, "bin")
    const backlog = join(dir, "home", "backlog")
    const startLog = join(dir, "starts.log")
    const arrivals = join(dir, "quota-arrivals")
    await mkdir(bin, { recursive: true })
    await mkdir(backlog, { recursive: true })
    await mkdir(arrivals)
    await writeFile(join(bin, "orc-quota"), fakeQuota(arrivals))
    await chmod(join(bin, "orc-quota"), 0o755)
    const start = ["sh", "-c", "sleep 0.1; echo \"$ORC_TASK_ID $ORC_TASK_MACHINE\" >> '" + startLog + "'"]
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: shape.mac, start }, { name: "linux", slots: shape.linux, start }],
      quota: quotaConfig(shape.floorPercent)
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({
      projects: [{ name: "orc", checkouts: { mac: join(dir, "mac-orc"), linux: join(dir, "linux-orc") } }]
    }))
    await writeFile(join(dir, "task.md"), "# Do the thing\n")
    await writeFile(startLog, "")
    await body({ dir, env: { ORC_HOME: join(dir, "home"), PATH: bin + ":" + (process.env.PATH ?? "") }, arrivals, startLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const startSettleMillis = 300

const startWaitMillis = 10_000

export const startedLines = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(fixture.startLog, "utf8")).split("\n").filter((line) => line !== "").sort()

export const eventually = async <A>(read: () => Promise<A>, done: (value: A) => boolean): Promise<A> => {
  const deadline = Date.now() + startWaitMillis
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(20)
    value = await read()
  }
  return value
}

// The beat does not wait on a start command, so a start shows in the log only after it ran, and a duplicate only after both ran.
export const settledStarts = async (fixture: Fixture, count: number): Promise<ReadonlyArray<string>> => {
  await eventually(() => startedLines(fixture), (lines) => lines.length >= count)
  await Bun.sleep(startSettleMillis)
  return startedLines(fixture)
}

export const addTasks = async (fixture: Fixture, count: number, machine: (index: number) => string | null = () => null): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const pin = machine(index)
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", ...(pin === null ? [] : ["--machine", pin])])
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const backlogTask = async (fixture: Fixture, id: string): Promise<Record<string, unknown> | undefined> => {
  const document: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
  if (!isRecord(document) || !Array.isArray(document.tasks)) {
    throw new Error("orc backlog --json printed no task list")
  }
  const tasks: ReadonlyArray<unknown> = document.tasks
  return tasks.filter(isRecord).find((task) => task.id === id)
}
