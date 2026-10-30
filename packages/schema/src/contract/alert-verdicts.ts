import { DateTime, Option, Schema } from "effect";
import { type Decoded, decodeJson, decoded, flatMapDecoded, rejected } from "../decode";
import { AlertEvent } from "./alerts";

export type AlertRule = AlertEvent["rule"];

export const alertRules: ReadonlyArray<AlertRule> = ["quota-pace", "heavy-load", "long-task", "nightly"];

export const AlertVerdictRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  event: AlertEvent,
  verdict: Schema.NullOr(Schema.NonEmptyString),
  recordedAt: Schema.String,
});

export type AlertVerdictRecord = typeof AlertVerdictRecord.Type;

export interface VerdictEntry {
  readonly event: AlertEvent;
  readonly firedAt: DateTime.Utc;
  readonly verdict: string | null;
  readonly recordedAt: DateTime.Utc;
}

const instantOf = (value: string, issue: string): Decoded<DateTime.Utc> =>
  Option.match(DateTime.make(value), { onNone: () => rejected(issue), onSome: (at) => decoded(DateTime.toUtc(at)) });

const decodeRecord = decodeJson(AlertVerdictRecord);

export const decodeVerdictLine = (line: string): Decoded<VerdictEntry> =>
  flatMapDecoded(decodeRecord(line), (record) =>
    flatMapDecoded(instantOf(record.event.at, "the event's at is not an instant"), (firedAt) =>
      flatMapDecoded(instantOf(record.recordedAt, "recordedAt is not an instant"), (recordedAt) =>
        decoded({ event: record.event, firedAt, verdict: record.verdict, recordedAt }),
      ),
    ),
  );
