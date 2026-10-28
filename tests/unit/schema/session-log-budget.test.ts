import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect } from "effect";
import { homeLogRoots, sessionLogSourceAt } from "@tui-dash/schema";
import { attentionLimitMillis } from "../../lib/budgets";
import { busyWeekBytes, writeWeekShare } from "../../lib/session-corpus";

const fraction = 20;
const weekMillis = 7 * 86_400_000;
const reads = 5;

const firstRead = (home: string, since: number) =>
  Effect.gen(function* () {
    const source = yield* sessionLogSourceAt(home, homeLogRoots(home), join(home, "capture-ledger"), [], { load: Effect.succeed(new Map()), keep: () => Effect.void });
    Bun.gc(true);
    // Elapsed time includes scheduler waits, not just the reader's work.
    const started = process.threadCpuUsage();
    const logs = yield* source.read({ pi: since, "claude-code": since });
    const spent = process.threadCpuUsage(started);
    return { busyMillis: (spent.user + spent.system) / 1_000, records: logs.files.reduce((sum, file) => sum + file.records.length, 0) };
  }).pipe(Effect.provide(BunFileSystem.layer));

describe("the session quota's first read of a week of logs, each log read once, not five times over", () => {
  test(
    `reads 1/${fraction} of a busy machine's week within that share of the attention limit`,
    async () => {
      const home = mkdtempSync(join(tmpdir(), "tui-dash-week-"));
      try {
        const now = Date.now();
        const corpus = writeWeekShare(home, fraction, now);
        const measured = [];
        for (let read = 0; read < reads; read++) measured.push(await Effect.runPromise(firstRead(home, now - weekMillis)));
        expect(measured.map((read) => read.records)).toEqual(Array.from({ length: reads }, () => corpus.markedLines));
        expect(Math.min(...measured.map((read) => read.busyMillis))).toBeLessThan((attentionLimitMillis * corpus.bytes) / busyWeekBytes);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
