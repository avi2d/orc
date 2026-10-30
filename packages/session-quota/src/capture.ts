import { Console, Data, DateTime, Effect, FileSystem, Result, Schema, Stdio, Stream } from "effect";
import {
  appendCaptured,
  captureLedgerDirectory,
  type CaptureRecord,
  claudeConfigDirectory,
  ClaudeStatuslineInput,
  claudeLogged,
  decodeValue,
  PiCallInput,
  piCallRecord,
  statuslineRecord,
} from "@tui-dash/schema";

const captureKinds = ["pi-call", "claude-statusline"] as const;

type CaptureKind = (typeof captureKinds)[number];

class CaptureRefused extends Data.TaggedError("CaptureRefused")<{ readonly reason: string }> {}

const isCaptureKind = Schema.is(Schema.Literals(captureKinds));

const parsed = <A>(schema: Schema.Decoder<A>, text: string): Effect.Effect<A, CaptureRefused> => {
  const json = Result.try((): unknown => JSON.parse(text));
  if (Result.isFailure(json)) return Effect.fail(new CaptureRefused({ reason: "stdin is not JSON" }));
  const input = decodeValue(schema)(json.success);
  return input.kind === "ok" ? Effect.succeed(input.value) : Effect.fail(new CaptureRefused({ reason: input.issue }));
};

const recordOf = (kind: CaptureKind, text: string) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    if (kind === "pi-call") return piCallRecord(yield* parsed(PiCallInput, text), now);
    if (!(yield* claudeLogged)) return undefined;
    return statuslineRecord(yield* parsed(ClaudeStatuslineInput, text), now, yield* claudeConfigDirectory);
  });

const kindOf = (args: ReadonlyArray<string>): Effect.Effect<CaptureKind, CaptureRefused> => {
  const kind = args.at(0);
  return isCaptureKind(kind)
    ? Effect.succeed(kind)
    : Effect.fail(new CaptureRefused({ reason: `expected one of ${captureKinds.join(", ")}, got ${kind ?? "nothing"}` }));
};

const captured = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const kind = yield* kindOf(yield* stdio.args);
  const text = yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString);
  const record: CaptureRecord | undefined = yield* recordOf(kind, text);
  if (record === undefined) return;
  yield* appendCaptured(yield* FileSystem.FileSystem, yield* captureLedgerDirectory, record);
});

const patience = "2 seconds";

const dropped = (reason: string) => Console.error(`tui-dash-capture: ${reason.split("\n").at(0) ?? reason}`);

// The hook runs inside the agent's turn, so a slow or failed capture is dropped with one line rather than holding or failing the turn.
export const capture: Effect.Effect<void, never, Stdio.Stdio | FileSystem.FileSystem> = captured.pipe(
  Effect.timeoutOrElse({
    duration: patience,
    orElse: () => Effect.fail(new CaptureRefused({ reason: `gave up after ${patience}` })),
  }),
  Effect.catchTags({
    CaptureRefused: (refused) => dropped(refused.reason),
    ConfigError: (error) => dropped(error.message),
    PlatformError: (error) => dropped(error.message),
    SchemaError: (error) => dropped(error.message),
  }),
);
