import { expect, test } from "bun:test"
import { ConfigProvider, DateTime, Duration, Effect } from "effect"
import { CommandRunner, PueueMachines, ok, subscriptionReport, unreachable } from "@avi2dg/orc-schema"
import { localRunningOrc, machineOverviewDocument, runningOrcByMachine, subscriptionOverviewDocument } from "@avi2dg/orc-cli"
import { machinesSnapshot, subscriptionsSnapshot } from "../../../packages/herdr-app/src/resources"

const running = { Running: { start: "2026-01-01T00:01:00Z" } }
const pueueStatus = (orcRuns: number): string => JSON.stringify({
  groups: {},
  tasks: Object.fromEntries(Array.from({ length: orcRuns }, (_, index) => [String(index), { id: index, group: "orc", command: "true", path: "/tmp", status: running }]))
})

const fakeRunner = (local: number, remote: string) => {
  const timeouts: Array<Duration.Duration> = []
  const runner = {
    run: ({ argv, timeout }: { readonly argv: readonly [string, ...string[]]; readonly timeout: Duration.Duration }) => {
      if (argv[0] === "pueue") return Effect.succeed(pueueStatus(local))
      if (argv[0] !== "ssh" || argv[1] !== "other-host") return Effect.die(new Error("Unexpected command " + argv.join(" ")))
      timeouts.push(timeout)
      return Effect.succeed(remote)
    }
  }
  return { runner, timeouts }
}

const unusedProjects = { resolve: () => Effect.void, known: Effect.succeed(new Map()) }
const legacyRead = Effect.die(new Error("the legacy pueue read ran although the peer answers running-orc"))

const countsByMachine = async (local: number, remote: number) => {
  const peerReply = JSON.stringify(await Effect.runPromise(localRunningOrc.pipe(Effect.provideService(CommandRunner, fakeRunner(remote, "").runner))))
  const { runner, timeouts } = fakeRunner(local, peerReply)
  const counts = await Effect.runPromise(runningOrcByMachine.pipe(
    Effect.provideService(PueueMachines, [{ name: "this-mac", read: legacyRead, projects: unusedProjects }, { name: "other-host", read: legacyRead, projects: unusedProjects }]),
    Effect.provideService(CommandRunner, runner),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ORC_DASH_REMOTE_PUEUE: "ssh other-host 'pueue status --json'" })))
  ))
  return { counts, timeouts }
}

test("the Machines table reads the running Orc jobs that machine-overview writes, not a renamed or missing runs field", async () => {
  const { counts } = await countsByMachine(2, 3)
  const document = JSON.parse(JSON.stringify(machineOverviewDocument([{ name: "this-mac", reading: unreachable("no sample yet") }], counts, "2026-01-03T11:00:00.000Z")))
  expect(machinesSnapshot(document, "")).toEqual({ kind: "ok", value: {
    machines: { kind: "ok", value: [{ name: "this-mac", reading: { kind: "failed", reason: "no sample yet" } }] },
    queues: { kind: "ok", value: [{ name: "this-mac", reading: { kind: "ok", value: 2 } }, { name: "other-host", reading: { kind: "ok", value: 3 } }] }
  } })
})

test("the Subscriptions table shows the per-machine warnings that subscription-overview writes", () => {
  const now = DateTime.makeUnsafe("2026-01-03T11:00:00Z")
  const earlier = DateTime.makeUnsafe("2026-01-03T10:50:00Z")
  const document = JSON.parse(JSON.stringify(subscriptionOverviewDocument(subscriptionReport([], now), [
    { name: "other-host", reading: ok(subscriptionReport([], earlier)) },
    { name: "far-host", reading: unreachable("ssh: connect to host far-host port 22: Operation timed out") }
  ])))
  expect(subscriptionsSnapshot(document, "")).toEqual({ kind: "ok", value: { kind: "ok", value: {
    accounts: [], windows: [],
    warnings: ["other-host: quota reading is stale", "far-host: ssh: connect to host far-host port 22: Operation timed out"]
  } } })
})
