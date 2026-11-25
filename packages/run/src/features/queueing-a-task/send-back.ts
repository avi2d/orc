import { Duration, Effect, type FileSystem } from "effect"
import { BacklogError, backlogPaths, findTask, runLabel, taskBranch, type TaskFileError, taskPr } from "../../entities/backlog/index"
import { addSendBackWords, sendBackClosedTask } from "../../entities/parked-runs/index"
import { prPattern, readPullRequest } from "../../entities/pull-request/index"
import { type ConfigError, type Machine, readDispatchConfig } from "../../shared/config/index"
import type { RunnerRequirements } from "./runner"
import { readRunResult } from "./runner-result"

export type SendBack = {
  readonly kind: "SendBack"
  readonly id: string
  readonly words: string
}

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail: "orc backlog send-back refused: " + detail }))

const readOriginRun = (id: string, home: string, label: string, machine: Machine) =>
  readRunResult(id, home, label, machine).pipe(
    Effect.map((result) => result.run?.id ?? null),
    Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.fail(new BacklogError({ detail: "orc backlog send-back refused: the runner did not answer within 30 seconds" })) })
  )

const refuseUnlessOpen = (url: string) =>
  Effect.gen(function*() {
    const view = yield* readPullRequest(url).pipe(Effect.mapError((error) => new BacklogError({ detail: "orc backlog send-back refused: " + error.detail })))
    if (view.state !== "OPEN") {
      return yield* refuse(url + " is " + view.state.toLowerCase() + ", so no run can update it")
    }
  })

export const sendBack = (
  root: string,
  home: string,
  args: SendBack,
  at: string,
  mergeRecord: "kept" | "cleared"
): Effect.Effect<string, BacklogError | ConfigError | TaskFileError, FileSystem.FileSystem | RunnerRequirements> =>
  Effect.gen(function*() {
    const record = yield* findTask(root, args.id)
    if (record.state.kind === "new") {
      const sentPr = record.parked?.origin?.pr
      if (sentPr !== undefined) {
        yield* refuseUnlessOpen(sentPr)
      }
      const origin = yield* addSendBackWords(root, args.id, args.words, at)
      return "added the review to " + args.id + ", so the next beat resumes run " + origin.run + " on " + taskBranch(args.id) + " with every review sent back"
    }
    if (record.state.kind !== "closed") {
      return yield* refuse(args.id + " is " + record.state.kind + ", and only a closed task goes back")
    }
    const url = taskPr(record)
    if (url === null || !prPattern.test(url)) {
      return yield* refuse(args.id + " names no pull request to send back")
    }
    yield* refuseUnlessOpen(url)
    const claim = record.state.claim
    if (claim === null) {
      return yield* refuse(args.id + " closed without a run, so it has no branch to send back")
    }
    const config = yield* readDispatchConfig(backlogPaths(root).dispatchConfig)
    const machine = config.machines.find((candidate) => candidate.name === claim.machine)
    if (machine === undefined) {
      return yield* refuse("the machine " + claim.machine + " that ran " + args.id + " is not in dispatch.json")
    }
    const run = yield* readOriginRun(args.id, home, runLabel(home, args.id, record.spec.kind), machine).pipe(
      Effect.catchTag("RunnerError", (error) => refuse("cannot read the run of " + args.id + " on " + claim.machine + ": " + error.detail))
    )
    if (run === null) {
      return yield* refuse("the runner on " + claim.machine + " holds no run of " + args.id + " to resume")
    }
    yield* sendBackClosedTask(root, args.id, args.words, at, { machine: claim.machine, run }, mergeRecord)
    return "sent " + args.id + " back, so the next beat resumes run " + run + " on " + taskBranch(args.id) + " with the review and its push updates " + url
  })
