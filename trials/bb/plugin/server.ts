import { execFile } from "node:child_process"
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk"
import { Data, Effect, Schema } from "effect"
import { boardNext, type TaskNext } from "../board-next"

const BoardTask = Schema.Struct({ id: Schema.String, title: Schema.String })
const Backlog = Schema.Struct({ schema: Schema.Literal("orc.backlog.v1"), tasks: Schema.Array(BoardTask) })
const BoardLine = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  waits: Schema.String,
  actor: Schema.NullOr(Schema.Literals(["owner", "orc", "ci"])),
  pr: Schema.NullOr(Schema.String)
})
export type BoardLine = typeof BoardLine.Type
const BoardReading = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok"), tasks: Schema.Array(BoardLine) }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String })
])
export type BoardReading = typeof BoardReading.Type

const backlogCommand = ["backlog", "--json"] as const

class BoardUnread extends Data.TaggedError("BoardUnread")<{ readonly reason: string }> {}

const orcOutput = Effect.callback<string, BoardUnread>((resume) => {
  execFile("orc", backlogCommand, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    resume(error === null ? Effect.succeed(stdout) : Effect.fail(new BoardUnread({ reason: `orc ${backlogCommand.join(" ")} failed: ${stderr.trim() || error.message}` })))
  })
})

const unreadable = (reason: string) => new BoardUnread({ reason: `orc printed a backlog this page cannot read: ${reason}` })

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeBacklog = Schema.decodeUnknownEffect(Backlog)

const waitsFor = ({ next }: TaskNext): string => {
  switch (next.waits) {
    case "priority": return "waits for a priority"
    case "decision": return "waits for a decision"
    case "hold": return "waits for its hold to be released"
    case "answer": return `waits for an answer to ${next.questions.join(", ")}`
    case "ci": return "waits for CI on its pull request"
    case "dependency": return "waits for a task it depends on"
    case "room": return "waits for room on a machine"
    case "run": return "waits for its run to finish"
    case "pull-request": return "waits for its pull request to be merged or closed"
    case "failed-run": return "waits after a failed run"
    case "nothing": return "waits for nothing"
  }
}

const boardLines = (value: unknown) => Effect.gen(function*() {
  const { tasks } = yield* decodeBacklog(value).pipe(Effect.mapError((error) => unreadable(error.message)))
  const nexts = boardNext(value, "")
  if (nexts.kind === "refused") return yield* Effect.fail(unreadable(nexts.reason))
  return tasks.map(({ id, title }, index): BoardLine => {
    const next = nexts.value[index]
    return { id, title, waits: waitsFor(next), actor: "actor" in next.next ? next.next.actor : null, pr: next.pr }
  })
})

const readBoard: Effect.Effect<BoardReading> = orcOutput.pipe(
  Effect.flatMap((stdout) => decodeJson(stdout).pipe(Effect.mapError((error) => unreadable(error.message)))),
  Effect.flatMap(boardLines),
  Effect.match({
    onFailure: ({ reason }): BoardReading => ({ kind: "failed", reason }),
    onSuccess: (tasks): BoardReading => ({ kind: "ok", tasks })
  })
)

// bb accepts a Standard Schema only when typeof gives "object", and an Effect schema is a callable class.
const standard = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => ({ "~standard": Schema.toStandardSchemaV1(schema)["~standard"] })

export const rpcContract = defineRpcContract({
  board: { input: standard(Schema.Null), output: standard(BoardReading) }
})

export default function plugin(bb: BbPluginApi): void {
  bb.rpc.register(rpcContract, { board: () => Effect.runPromise(readBoard) })
}
