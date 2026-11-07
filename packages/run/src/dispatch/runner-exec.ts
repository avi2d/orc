import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RunnerError } from "./runner-error"

export type Command = readonly [string, ...Array<string>]

export interface Captured {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const capture = (command: Command, stdin: string | null, env?: Record<string, string>): Effect.Effect<Captured, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = command
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, env === undefined
      ? {
        stdin: stdin === null ? "ignore" : Stream.fromIterable([new TextEncoder().encode(stdin)])
      }
      : {
        stdin: stdin === null ? "ignore" : Stream.fromIterable([new TextEncoder().encode(stdin)]),
        env,
        extendEnv: true
      }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { exitCode, stdout, stderr }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new RunnerError({ detail: command[0] + " did not run: " + error.message }))
  )

export const pueue = (args: ReadonlyArray<string>, env?: Record<string, string>): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(["pueue", ...args], null, env).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(new RunnerError({ detail: "pueue " + (args[0] ?? "") + " exited " + result.exitCode + ": " + result.stderr.trim() }))
    )
  )

export const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
  what: string
): Effect.Effect<S["Type"], RunnerError> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new RunnerError({ detail: what + " printed no JSON" }) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: what + " printed JSON orc cannot read: " + error.message }))
  )

// A decode failure carries the text it read, which may hold the token, so the refusal names only the shape it wanted.
export const decodeSecret = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
  refusal: string
): Effect.Effect<S["Type"], RunnerError> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new RunnerError({ detail: refusal }) }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json, { onExcessProperty: "error" })),
    Effect.mapError(() => new RunnerError({ detail: refusal }))
  )
