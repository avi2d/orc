import { Config, Context, DateTime, Duration, Effect, FileSystem, Layer, Option } from "effect";
import { type AgentReplies, saidOfTurns, saidToday, type SaidMessage } from "./ledger";
import { CommandRunner, selector } from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";
import { sessionTurns, type SessionTurn } from "./session-turns";

type Runner = CommandRunner["Service"];

interface LedgerSettings {
  readonly sessions: string | undefined;
  readonly classify: string | undefined;
  readonly replies: AgentReplies;
}

const ledgerSettings: Config.Config<LedgerSettings> = Config.all({
  sessions: selector("TUI_DASH_LEDGER_SESSIONS"),
  classify: selector("TUI_DASH_LEDGER_CLASSIFY"),
  name: selector("TUI_DASH_LEDGER_AGENT"),
  address: selector("TUI_DASH_LEDGER_ADDRESS"),
  ack: selector("TUI_DASH_LEDGER_ACK"),
}).pipe(
  Config.map(({ sessions, classify, name, address, ack }) => ({
    sessions,
    classify,
    replies: { name: name?.trim() ?? "assistant", address: address?.trim(), ack: ack?.trim() },
  })),
);

const readChunk = 65536;

const readTail = (fs: FileSystem.FileSystem, path: string, offset: number): Effect.Effect<string, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path);
      yield* file.seek(BigInt(offset), "start");
      const chunks: Array<Uint8Array> = [];
      while (true) {
        const chunk = yield* file.readAlloc(readChunk);
        if (Option.isNone(chunk)) break;
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return new TextDecoder().decode(bytes);
    }),
  );

const classifyScript = 'printf "%s" "$2" | eval "$1"';

// The classifier reads the message on stdin, prints something when it is operational and nothing otherwise, and exits zero or one.
// A classifier that cannot run keeps the turn: a noisy row beats a question nobody sees.
const isOperational = (runner: Runner, command: string, text: string): Effect.Effect<boolean> =>
  Effect.map(
    Effect.orElseSucceed(
      runner.run({ argv: ["sh", "-c", classifyScript, "ledger-classify", command, text], timeout: Duration.seconds(10), exitCodes: [0, 1] }),
      () => "",
    ),
    (out) => out !== "",
  );

const scoreTurns = (runner: Runner, command: string, turns: ReadonlyArray<SessionTurn>): Effect.Effect<ReadonlyArray<SessionTurn>> =>
  Effect.forEach(turns, (turn) =>
    turn.role === "user"
      ? Effect.map(isOperational(runner, command, turn.text.trim()), (skip) => (skip ? { ...turn, operational: true } : turn))
      : Effect.succeed(turn),
  );

export class ConversationSource extends Context.Service<ConversationSource, ConversationReader>()("tui-dash/Conversation") {}

interface FileState {
  readonly offset: number;
  readonly lines: number;
  readonly said: ReadonlyArray<SaidMessage>;
}

export type LedgerFeed = { readonly sessions: "unset" } | { readonly sessions: "set"; readonly said: ReadonlyArray<SaidMessage> };

export interface ConversationReader {
  readonly read: (now: DateTime.Utc, zone: DateTime.TimeZone) => Effect.Effect<LedgerFeed, never, FileSystem.FileSystem>;
}

// The session files only grow, so each read parses just the new tail and remembers what it already said.
// A file that shrank was replaced, so it reads from the start again.
export const makeConversationReader = (runner: Runner): ConversationReader => {
  const states = new Map<string, FileState>();
  const readFile = (
    fs: FileSystem.FileSystem,
    settings: LedgerSettings,
    directory: string,
    name: string,
    start: number,
  ): Effect.Effect<ReadonlyArray<SaidMessage>> =>
    Effect.gen(function* () {
      const path = `${directory}/${name}`;
      const stat = yield* Effect.orElseSucceed(fs.stat(path), () => undefined);
      const size = stat === undefined ? undefined : Number(stat.size);
      const modified =
        stat === undefined ? Number.POSITIVE_INFINITY : Option.match(stat.mtime, { onNone: () => Number.POSITIVE_INFINITY, onSome: (date) => date.getTime() });
      if (size === undefined || modified < start) {
        states.delete(path);
        return [];
      }
      const kept = states.get(path) ?? { offset: 0, lines: 0, said: [] };
      const from = size < kept.offset ? { offset: 0, lines: 0, said: [] as ReadonlyArray<SaidMessage> } : kept;
      if (size === from.offset) return from.said;
      const tail = yield* Effect.orElseSucceed(readTail(fs, path, from.offset), () => undefined);
      if (tail === undefined) return from.said;
      const cut = tail.lastIndexOf("\n");
      if (cut === -1) return from.said;
      const complete = tail.slice(0, cut + 1);
      const turns = sessionTurns(name, complete, from.lines);
      const fresh = turns.filter((turn) => turn.role === "user" && DateTime.toEpochMillis(turn.at) >= start);
      const scoredFresh = settings.classify === undefined ? fresh : yield* scoreTurns(runner, settings.classify, fresh);
      const scoredByLine = new Map(scoredFresh.map((turn) => [turn.line, turn] as const));
      const scored = turns.map((turn) => scoredByLine.get(turn.line) ?? turn);
      const said = saidOfTurns(name, scored, settings.replies);
      states.set(path, {
        offset: from.offset + Buffer.byteLength(complete, "utf8"),
        lines: from.lines + complete.split("\n").length - 1,
        said: [...from.said, ...said],
      });
      return states.get(path)?.said ?? [];
    });
  return {
    read: (now, zone) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settings = Option.getOrUndefined(yield* Effect.option(ledgerSettings));
        const directory = settings?.sessions;
        if (settings === undefined || directory === undefined) return { sessions: "unset" } as const;
        const start = DateTime.toEpochMillis(DateTime.startOf(DateTime.setZone(now, zone), "day"));
        const names = yield* Effect.orElseSucceed(fs.readDirectory(directory), (): ReadonlyArray<string> => []);
        const files = names.filter((name) => name.endsWith(".jsonl")).toSorted();
        const said = yield* Effect.forEach(files, (name) => readFile(fs, settings, directory, name, start), { concurrency: 8 });
        return { sessions: "set", said: saidToday(said.flat(), now, zone) } as const;
      }),
  };
};

export const conversationSourceLive: Layer.Layer<ConversationSource> = Layer.effect(
  ConversationSource,
  Effect.map(CommandRunner, makeConversationReader),
).pipe(Layer.provide(liveCommandRunner));
