import { execFile } from "node:child_process"
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk"
import { Data, Effect, Schema } from "effect"

const BoardTask = Schema.Struct({ id: Schema.String, title: Schema.String })
const Backlog = Schema.Struct({ schema: Schema.Literal("orc.backlog.v1"), tasks: Schema.Array(BoardTask) })
const BoardReading = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok"), tasks: Schema.Array(BoardTask) }),
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

const decodeBacklog = Schema.decodeUnknownEffect(Schema.fromJsonString(Backlog))

const readBoard: Effect.Effect<BoardReading> = orcOutput.pipe(
  Effect.flatMap((stdout) => decodeBacklog(stdout).pipe(Effect.mapError((error) => new BoardUnread({ reason: `orc printed a backlog this page cannot read: ${error.message}` })))),
  Effect.match({
    onFailure: ({ reason }): BoardReading => ({ kind: "failed", reason }),
    onSuccess: ({ tasks }): BoardReading => ({ kind: "ok", tasks })
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
