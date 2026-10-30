import { DateTime, Option, Result, Schema } from "effect";

export interface SessionTurn {
  readonly file: string;
  readonly line: number;
  readonly at: DateTime.Utc;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly operational: boolean;
}

const TurnJson = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.String,
  message: Schema.Struct({
    role: Schema.String,
    content: Schema.Array(Schema.Struct({ type: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) })),
  }),
});

const parseTurn = (file: string, index: number, line: string): SessionTurn | undefined => {
  const parsed = Result.try((): unknown => JSON.parse(line));
  if (!Result.isSuccess(parsed)) return undefined;
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TurnJson)(parsed.success));
  if (decoded === undefined || decoded.type !== "message") return undefined;
  if (decoded.message.role !== "user" && decoded.message.role !== "assistant") return undefined;
  const text = decoded.message.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
  if (text.trim() === "") return undefined;
  const at = Option.getOrUndefined(Option.map(DateTime.make(decoded.timestamp), DateTime.toUtc));
  if (at === undefined) return undefined;
  return { file, line: index, at, text, role: decoded.message.role === "user" ? "user" : "assistant", operational: false };
};

// A torn line or a line without spoken text is not a turn.
export const sessionTurns = (file: string, jsonl: string, base = 0): ReadonlyArray<SessionTurn> =>
  jsonl.split("\n").flatMap((line, index) => {
    const turn = parseTurn(file, base + index, line);
    return turn === undefined ? [] : [turn];
  });
