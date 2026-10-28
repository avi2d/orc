import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import {
  AlertVerdictRecord,
  decodeVerdictLine,
  judgesFire,
  type Outcome,
  type RuleRecord,
  ruleRecords,
  type VerdictEntry,
  type VerdictLog,
  verdictLogReaderAt,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const recordedLines = fixture("alerts/verdicts.jsonl").split("\n").filter((line) => line !== "");

const entries = (): ReadonlyArray<VerdictEntry> =>
  recordedLines.map((line) => {
    const entry = decodeVerdictLine(line);
    if (entry.kind !== "ok") throw new Error(`the fixture line does not decode: ${entry.issue}`);
    return entry.value;
  });

const iso = (at: DateTime.Utc | undefined): string | undefined => (at === undefined ? undefined : DateTime.formatIso(at));

const subjects = (events: ReadonlyArray<{ readonly rule: string; readonly machine?: string; readonly at: string }>) =>
  events.map((event) => [event.rule, event.machine, event.at]);

describe("the rule records of a verdict log", () => {
  const records = ruleRecords(entries());
  const recordOf = (rule: RuleRecord["rule"]): RuleRecord => {
    const record = records.find((each) => each.rule === rule);
    if (record === undefined) throw new Error(`no record for ${rule}`);
    return record;
  };
  const quotaPace = recordOf("quota-pace");
  const heavyLoad = recordOf("heavy-load");
  const longTask = recordOf("long-task");

  test("leave a rule no line names without a fire or a verdict", () => {
    expect(quotaPace).toEqual({ rule: "quota-pace", fire: undefined, verdict: undefined });
  });

  test("decode the judged line the refusals below start from", () => {
    expect(decodeVerdictLine(JSON.stringify(judgedRecord)).kind).toBe("ok");
  });

  test("hold every event of the latest fire once, and the verdict that judged it", () => {
    expect(heavyLoad.rule).toBe("heavy-load");
    expect(iso(heavyLoad.fire?.at)).toBe("2026-10-19T18:40:00.000Z");
    expect(subjects(heavyLoad.fire?.events ?? [])).toEqual([
      ["heavy-load", "south", "2026-10-19T18:40:00.000Z"],
      ["heavy-load", "north", "2026-10-19T18:40:00.000Z"],
    ]);
    expect(heavyLoad.verdict?.verdict).toBe("expected, a nightly baseline runs on south");
    expect(heavyLoad.verdict !== undefined && heavyLoad.fire !== undefined && judgesFire(heavyLoad.verdict, heavyLoad.fire)).toBe(true);
  });

  test("keep the latest verdict when it judged an earlier fire than the last", () => {
    expect(iso(longTask.fire?.at)).toBe("2026-10-19T19:10:00.000Z");
    expect(longTask.fire?.events).toHaveLength(1);
    expect(longTask.verdict?.verdict).toBe("still moving the queue, let it run");
    expect(iso(longTask.verdict?.firedAt)).toBe("2026-10-19T18:55:00.000Z");
    expect(longTask.verdict !== undefined && longTask.fire !== undefined && judgesFire(longTask.verdict, longTask.fire)).toBe(false);
  });

  // Spreading every line into one call throws past the argument limit, so the last fire is found by a loop.
  test("find the last fire of a history longer than a call takes arguments", () => {
    const recorded = entries();
    const first = recorded.at(0);
    const last = recorded.at(-1);
    if (first === undefined || last === undefined) throw new Error("the fixture has no lines");
    const history = [...Array.from({ length: 1_200_000 }, () => first), last];
    const fire = ruleRecords(history).find((record) => record.rule === last.event.rule)?.fire;
    expect(iso(fire?.at)).toBe("2026-10-19T19:10:00.000Z");
  });
});

const judgedRecord = Schema.decodeSync(Schema.fromJsonString(AlertVerdictRecord))(recordedLines[2] ?? "");

const { recordedAt: _, ...unrecorded } = judgedRecord;

describe("a verdict line", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["an empty verdict", JSON.stringify({ ...judgedRecord, verdict: "" })],
    ["no recordedAt", JSON.stringify(unrecorded)],
    ["a recordedAt that is no instant", JSON.stringify({ ...judgedRecord, recordedAt: "yesterday" })],
    ["another schema version", JSON.stringify({ ...judgedRecord, schemaVersion: 2 })],
    ["an event of no rule the engine has", JSON.stringify({ ...judgedRecord, event: { ...judgedRecord.event, rule: "disk-full" } })],
    ["an event whose at is no instant", JSON.stringify({ ...judgedRecord, event: { ...judgedRecord.event, at: "soon" } })],
    ["text that is not JSON", "verdict: fine"],
  ];
  for (const [what, line] of refused) {
    test(`is refused with ${what}`, () => {
      expect(decodeVerdictLine(line).kind).toBe("invalid");
    });
  }
});

const directory = mkdtempSync(join(tmpdir(), "tui-dash-verdicts-"));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const readerAt = (path: string) =>
  Effect.runSync(Effect.map(FileSystem.FileSystem, (fs) => verdictLogReaderAt(fs, path)).pipe(Effect.provide(BunFileSystem.layer)));

const readWith = (read: Effect.Effect<Outcome<VerdictLog>>): Promise<Outcome<VerdictLog>> => Effect.runPromise(read);

const counts = (log: Outcome<VerdictLog>) => (log.kind === "ok" ? { entries: log.value.entries.length, unreadable: log.value.unreadable } : log);

describe("the verdict log reader", () => {
  test("reads a log no listener has written as empty", async () => {
    expect(counts(await readWith(readerAt(join(directory, "absent.jsonl"))))).toEqual({ entries: 0, unreadable: 0 });
  });

  test("counts a line that is no record and reads a line appended since its last read", async () => {
    const path = join(directory, "grown.jsonl");
    writeFileSync(path, `${recordedLines.slice(0, 2).join("\n")}\nnot a record\n`);
    const read = readerAt(path);
    expect(counts(await readWith(read))).toEqual({ entries: 2, unreadable: 1 });
    appendFileSync(path, `${recordedLines.slice(2).join("\n")}\n`);
    expect(counts(await readWith(read))).toEqual({ entries: 6, unreadable: 1 });
  });

  test("reads a log that was replaced from its start", async () => {
    const path = join(directory, "replaced.jsonl");
    writeFileSync(path, `${recordedLines.join("\n")}\n`);
    const read = readerAt(path);
    expect(counts(await readWith(read))).toEqual({ entries: 6, unreadable: 0 });
    writeFileSync(path, `${recordedLines[0]}\n`);
    expect(counts(await readWith(read))).toEqual({ entries: 1, unreadable: 0 });
  });

  test("reports a refresh it cannot read as unreachable, then reads the log again once it can", async () => {
    const path = join(directory, "lost.jsonl");
    writeFileSync(path, `${recordedLines.slice(0, 2).join("\n")}\n`);
    const read = readerAt(path);
    expect(counts(await readWith(read))).toEqual({ entries: 2, unreadable: 0 });
    rmSync(path);
    mkdirSync(path);
    const lost = await readWith(read);
    expect(lost.kind).toBe("unreachable");
    expect(lost.kind === "unreachable" ? lost.reason : "").toContain(path);
    rmSync(path, { recursive: true });
    writeFileSync(path, `${recordedLines.join("\n")}\n`);
    expect(counts(await readWith(read))).toEqual({ entries: 6, unreadable: 0 });
  });

  test("names the path of a log it cannot read", async () => {
    const log = await readWith(readerAt(directory));
    expect(log.kind).toBe("unreachable");
    expect(log.kind === "unreachable" ? log.reason : "").toContain(directory);
  });
});
