import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema } from "effect";
import {
  type QuotaBlock,
  QuotaBlocksCodec,
  type SessionQuotaView,
  type Shown,
  SessionsCodec,
  savedReadingsLayer,
  savedStandIn,
  type WindowView,
} from "@tui-dash/schema";

const shownAt = Date.parse("2026-10-26T00:30:05Z");

const handWrittenBlock: QuotaBlock = {
  provider: "claude",
  title: "claude main",
  body: {
    kind: "live",
    plan: "max",
    reportedAt: DateTime.makeUnsafe("2026-10-26T00:30:00Z"),
    state: { status: "fresh", stale: false },
    windows: [
      {
        id: "five_hour",
        label: "5h",
        kind: "session",
        percentRemaining: 62,
        resetsAt: DateTime.makeUnsafe("2026-10-26T05:00:00Z"),
        pace: { status: "ahead", cycleSeconds: 18_000, timeRemainingPercent: 90, reservePercentPoints: -28 },
        source: {
          kind: "harvested",
          harness: "claude-code",
          via: "headless",
          observedAt: DateTime.makeUnsafe("2026-10-26T00:30:00Z"),
          file: "/home/tester/.claude/projects/work/run.jsonl",
          join: { kind: "default-account" },
        },
      },
    ],
    exhaustion: [],
  },
};

const noTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const handWrittenWindow: WindowView = {
  id: "five_hour",
  label: "5h",
  kind: "session",
  source: {
    kind: "harvested",
    harness: "claude-code",
    via: "headless",
    observedAt: DateTime.makeUnsafe("2026-10-26T00:30:00Z"),
    file: "/home/tester/.claude/projects/work/run.jsonl",
    join: { kind: "default-account" },
  },
  cycleSeconds: 18_000,
  startsAt: DateTime.makeUnsafe("2026-10-25T23:00:00Z"),
  resetsAt: DateTime.makeUnsafe("2026-10-26T04:00:00Z"),
  usedPoints: 38,
  leftPoints: 62,
  pace: "ahead",
  elapsedFraction: 0.3,
  aheadOfPace: true,
  pastFirstTenth: true,
  exhaustsBeforeReset: false,
  verdict: null,
  sustainablePointsPerHour: null,
  activeSessions: 1,
  fairPointsPerHour: null,
  observedCalls: 0,
  observedTokens: noTokens,
  unattributedPoints: 0,
  sessions: [],
  otherCycle: [],
};

const handWrittenSessions: SessionQuotaView = {
  now: DateTime.makeUnsafe("2026-10-26T00:30:00Z"),
  quota: undefined,
  panes: undefined,
  processes: undefined,
  accounts: [
    {
      provider: "claude",
      accountKey: "default",
      credentialKey: undefined,
      accountKeys: [],
      title: "claude main",
      joins: [{ kind: "default-account" }],
      body: { kind: "windows", windows: [handWrittenWindow] },
    },
  ],
  sessions: [],
  modelsSinceMidnight: [],
  unmatched: [],
  ledger: { bridgeCopiesDropped: 0, repeatedLinesDropped: 0, emptyRowsDropped: 0, forkCopiesDropped: 0, repeatedCountsDropped: 0 },
  unmetered: [],
  unjoinedCalls: 0,
};

const savedBlockJson = (via: string) => [
  {
    provider: "claude",
    title: "claude main",
    body: {
      kind: "live",
      plan: "max",
      reportedAt: "2026-10-26T00:30:00.000Z",
      state: { status: "fresh", stale: false },
      exhaustion: [],
      windows: [
        {
          id: "five_hour",
          label: "5h",
          kind: "session",
          percentRemaining: 62,
          resetsAt: "2026-10-26T05:00:00.000Z",
          source: {
            kind: "harvested",
            harness: "claude-code",
            via,
            observedAt: "2026-10-26T00:30:00.000Z",
            file: "/home/tester/.claude/projects/work/run.jsonl",
            join: { kind: "default-account" },
          },
        },
      ],
    },
  },
];

const savedUnder = (directory: string) =>
  savedReadingsLayer.pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/tester", XDG_STATE_HOME: directory }))),
  );

const saveAndRestore = async <A>(key: string, codec: Schema.Codec<A, unknown>, value: A, at: number): Promise<Shown<A>> => {
  const directory = await mkdtemp(join(tmpdir(), "tui-dash-saved-"));
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const standIn = yield* savedStandIn(key, codec);
        yield* standIn(Option.some({ value, at }));
      }).pipe(Effect.provide(savedUnder(directory))),
    );
    return await Effect.runPromise(
      Effect.gen(function* () {
        const standIn = yield* savedStandIn(key, codec);
        return yield* standIn(Option.none());
      }).pipe(Effect.provide(savedUnder(directory))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("the saved quota blocks", () => {
  test("restore a headless Claude window as it was written", async () => {
    expect(await saveAndRestore("quota", QuotaBlocksCodec, [handWrittenBlock], shownAt)).toEqual({
      kind: "saved",
      value: [handWrittenBlock],
      at: shownAt,
    });
  });

  test("restore a headless Claude window in the sessions copy as it was written", async () => {
    expect(await saveAndRestore("sessions", SessionsCodec, handWrittenSessions, shownAt)).toEqual({
      kind: "saved",
      value: handWrittenSessions,
      at: shownAt,
    });
  });

  test("accepts a headless Claude window and refuses an unknown route", () => {
    const decode = Schema.decodeUnknownOption(Schema.toCodecJson(QuotaBlocksCodec));
    expect(Option.isSome(decode(savedBlockJson("headless")))).toBe(true);
    expect(Option.isNone(decode(savedBlockJson("relay")))).toBe(true);
  });
});
