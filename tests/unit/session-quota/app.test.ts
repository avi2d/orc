import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, ConfigProvider, Deferred, DateTime, Duration, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import {
  CommandRunner,
  CommandUnreachable,
  ComposedSessionQuotaReport,
  herdrSourceLayer,
  linuxHarnessProcessSourceLayer,
  quotaSourceLayer,
  SessionQuotaAlert,
  sessionMachinesLayer,
  sessionQuotaReport,
  inBackground,
} from "@tui-dash/schema";
import { createTestRenderer } from "@opentui/core/testing";
import {
  livePanel,
  harvestLogSourceLive,
  printComposedSessionQuotaJson,
  printSessionQuotaFrame,
  printSessionQuotaJson,
  sessionLogSourceLive,
  streamSessionQuotaAlerts,
} from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";
import { machineStdout } from "../../lib/machines-fixture";
import {
  copyFixtureHome,
  fixtureSessionView,
  recordedNow,
  relocated,
  unrelocated,
} from "../../lib/session-fixture";
import { isSavedProfilesCall, recordedSavedProfilesLayer } from "../../lib/saved-profiles";

let home = "";

beforeEach(() => {
  roundsStarted = 0;
  home = mkdtempSync(join(tmpdir(), "tui-dash-session-quota-"));
  copyFixtureHome(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const atHome = (text: string) => relocated(text, home);

let roundsStarted = 0;

const remoteCommand = "ssh south.example.com tui-dash-session-quota --json";

const remoteEnv = { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_SESSION_QUOTA: remoteCommand };

interface Remote {
  readonly env: Record<string, string>;
  readonly answer: Effect.Effect<string, CommandUnreachable>;
}

const noRemote: Remote = { env: {}, answer: Effect.fail(new CommandUnreachable({ reason: "no remote is configured" })) };

const recordedReads = (herdrAnswer: Effect.Effect<void> = Effect.void, remote: Remote = noRemote) =>
  Layer.mergeAll(
    quotaSourceLayer,
    recordedSavedProfilesLayer,
    herdrSourceLayer,
    linuxHarnessProcessSourceLayer,
    sessionMachinesLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(remote.env)))),
  ).pipe(
    Layer.provide(
      Layer.succeed(CommandRunner, {
        run: (command) => {
          const [program] = command.argv;
          if (program === "sh" && command.argv[2] === remoteCommand) return remote.answer;
          if (program === "quota-axi") {
            roundsStarted += 1;
            return Effect.succeed(fixture("quota-axi/full.json"));
          }
          if (isSavedProfilesCall(command)) return Effect.succeed(fixture("saved-profiles/status.json"));
          if (program === "herdr") return Effect.as(herdrAnswer, atHome(fixture("session-logs/herdr-agents.json")));
          return Effect.succeed(atHome(fixture("session-logs/harness-processes.txt")));
        },
      }),
    ),
    Layer.merge(
      Layer.merge(sessionLogSourceLive, harvestLogSourceLive).pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home }))),
      ),
    ),
  );

const recordedSources = (remote: Remote = noRemote) =>
  recordedReads(Effect.void, remote).pipe(Layer.merge(TestConsole.layer), Layer.merge(TestClock.layer()));

const printedFrom = <A, E>(program: Effect.Effect<A, E, Layer.Success<ReturnType<typeof recordedSources>>>, remote = noRemote) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(recordedNow));
      yield* program;
      const lines = yield* TestConsole.logLines;
      return lines.map(String);
    }).pipe(Effect.provide(recordedSources(remote))),
  );

const southAtRecordedNow = machineStdout("south", (report) => ({ ...report, generatedAt: DateTime.formatIso(recordedNow) }));

const answered = (stdout: string): Remote => ({ env: remoteEnv, answer: Effect.succeed(stdout) });

const decodeComposed = Schema.decodeUnknownSync(Schema.fromJsonString(ComposedSessionQuotaReport));

const decodeAlert = Schema.decodeUnknownSync(Schema.fromJsonString(SessionQuotaAlert));

describe("the session quota commands over the fixture home matching the hand-worked session-pipeline view", () => {
  test("--json prints the version 1 report the in-memory pipeline builds, once", async () => {
    const lines = await printedFrom(printSessionQuotaJson);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(unrelocated(lines[0] ?? "", home))).toEqual(
      JSON.parse(JSON.stringify(sessionQuotaReport(fixtureSessionView()))),
    );
  });

  test("--alerts raises each flag once, stays quiet while they hold, and clears each once its trailing hour goes quiet", async () => {
    const realPause = Effect.promise(() => Bun.sleep(5));
    let roundsParked = 0;
    const parkCountingClock = Layer.effect(
      Clock.Clock,
      Effect.map(TestClock.make(), (clock) => ({
        ...clock,
        sleep: (duration: Duration.Duration) =>
          Effect.suspend(() => {
            if (Duration.toMillis(duration) === 30_000) roundsParked += 1;
            return clock.sleep(duration);
          }),
      })),
    );
    const until = (holds: () => boolean, failure: string) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
          if (holds()) return;
          yield* realPause;
        }
        return yield* Effect.die(failure);
      });
    const alertsOnceThere = (count: number) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 1_200; attempt += 1) {
          const lines = yield* TestConsole.logLines;
          if (lines.length >= count) return lines.map((line) => decodeAlert(unrelocated(String(line), home)));
          yield* realPause;
        }
        return yield* Effect.die(`fewer than ${count} alerts`);
      });
    // An advance fired before the round rearms its 30 second sleep misses it and still moves the clock its alerts are stamped with.
    const nextRound = Effect.gen(function* () {
      const started = roundsStarted;
      yield* until(() => roundsParked === started, "the round never rearmed its sleep");
      yield* TestClock.adjust("30 seconds");
      yield* until(() => roundsStarted !== started, "the next round never started");
    });
    const [raised, held, settled] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(recordedNow));
        const stream = yield* Effect.forkChild(streamSessionQuotaAlerts);
        const first = yield* alertsOnceThere(4);
        yield* nextRound;
        yield* nextRound;
        yield* nextRound;
        const quiet = yield* TestConsole.logLines;
        for (let round = 0; round < 300 && (yield* TestConsole.logLines).length < 8; round += 1) yield* nextRound;
        const all = yield* alertsOnceThere(8);
        yield* Fiber.interrupt(stream);
        return [first, quiet.length, all.slice(4)] as const;
      }).pipe(Effect.provide(recordedReads().pipe(Layer.merge(TestConsole.layer), Layer.merge(parkCountingClock)))),
    );
    expect(raised.map((alert) => [alert.event, alert.flag.session, alert.flag.window, alert.at])).toEqual([
      ["flagged", "pane:w1A:p2", "seven_day", "2026-10-13T20:18:16.000Z"],
      ["flagged", "pane:w2B:p2", "seven_day", "2026-10-13T20:18:16.000Z"],
      ["flagged", "pid:4242", "seven_day", "2026-10-13T20:18:16.000Z"],
      ["flagged", "pane:w2B:p2", "monthly", "2026-10-13T20:18:16.000Z"],
    ]);
    expect(held).toBe(4);
    expect(settled.map((alert) => [alert.event, alert.flag.session, alert.flag.window])).toEqual([
      ["cleared", "pane:w2B:p2", "seven_day"],
      ["cleared", "pid:4242", "seven_day"],
      ["cleared", "pane:w2B:p2", "monthly"],
      ["cleared", "pane:w1A:p2", "seven_day"],
    ]);
    const clearedAt = settled.map((alert) => Date.parse(alert.at));
    for (const [index, lastCall] of ["19:50", "20:00", "20:05", "20:10"].entries()) {
      const hourAfter = Date.parse(`2026-10-13T${lastCall}:00Z`) + 3_600_000;
      expect(clearedAt[index]).toBeGreaterThanOrEqual(hourAfter);
      expect(clearedAt[index]).toBeLessThan(hourAfter + 2 * 60_000);
    }
  }, 60_000);
});

describe("the session quota commands with a remote machine configured, against the in-memory view and the invented south contract", () => {
  test("--composed-json prints one version 2 report holding this machine's sessions and the remote's, each on its machine", async () => {
    const lines = await printedFrom(printComposedSessionQuotaJson, answered(southAtRecordedNow));
    expect(lines).toHaveLength(1);
    const report = decodeComposed(lines[0] ?? "");
    expect(report.machines.map((machine) => [machine.name, machine.role, machine.status, machine.combined])).toEqual([
      ["north", "local", "ok", true],
      ["south", "remote", "ok", true],
    ]);
    const local = fixtureSessionView().sessions.map((session) => session.id);
    expect(report.sessions.map((session) => [session.machine, unrelocated(session.id, home)])).toEqual([
      ...local.map((id) => ["north", id]),
      ["south", "pane:w1"],
      ["south", "file:/home/tester/.pi/agent/sessions/--home-tester-notes--/2026-10-15T08-00-00-000Z_eeeeeeee-0000-4000-8000-00000000e001.jsonl"],
    ]);
  });

  test("--json stays this machine's version 1 report", async () => {
    const lines = await printedFrom(printSessionQuotaJson, answered(southAtRecordedNow));
    expect(JSON.parse(unrelocated(lines[0] ?? "", home))).toEqual(
      JSON.parse(JSON.stringify(sessionQuotaReport(fixtureSessionView()))),
    );
  });

  test("--composed-json names a remote command that failed and keeps only this machine's sessions", async () => {
    const refused = { env: remoteEnv, answer: Effect.fail(new CommandUnreachable({ reason: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused" })) };
    const report = decodeComposed((await printedFrom(printComposedSessionQuotaJson, refused))[0] ?? "");
    expect(report.machines.at(1)).toEqual({
      name: "south",
      role: "remote",
      status: "unreachable",
      detail: "sh exited 255: ssh: connect to host south.example.com port 22: Connection refused",
      generatedAt: null,
      combined: false,
      sources: null,
      failedAccounts: [],
    });
    expect(report.sessions.every((session) => session.machine === "north")).toBe(true);
  });

  test("--print captions the rows with both machines and labels the remote's rows", async () => {
    const text = (await printedFrom(printSessionQuotaFrame(84), answered(southAtRecordedNow))).join("\n");
    expect(text).toContain("estimates from north and south logs");
    expect(text).toContain("south ~/work/api w1");
  });
});

describe("inBackground", () => {
  test("hands back nothing while the first read outlasts its patience, then the read once it lands, without starting a second", async () => {
    const [first, second, started] = await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        let starts = 0;
        const read = yield* inBackground(
          (value: number) =>
            Effect.gen(function* () {
              starts += 1;
              yield* Deferred.await(gate);
              return value;
            }),
          "10 millis",
        );
        const before = yield* read(1);
        yield* Deferred.succeed(gate, undefined);
        const after = yield* read(2);
        return [before, after, starts] as const;
      })),
    );
    expect(first).toEqual(Option.none());
    expect(second).toEqual(Option.some(1));
    expect(started).toBe(1);
  });

  test("keeps the last finished read while the next one is still running", async () => {
    const results = await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const read = yield* inBackground(
          (value: number) => (value === 1 ? Effect.succeed(value) : Deferred.await(gate).pipe(Effect.as(value))),
          "10 millis",
        );
        return [yield* read(1), yield* read(2)];
      })),
    );
    expect(results).toEqual([Option.some(1), Option.some(1)]);
  });
});

describe("the live session quota panel", () => {
  test("paints the captioned session rows inside a standard 84x24 terminal, and ends on the quit key", async () => {
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedReads())));
    try {
      let frame = "";
      for (let attempt = 0; attempt < 200 && !frame.includes("claude main"); attempt += 1) {
        await Bun.sleep(25);
        await setup.renderOnce();
        frame = setup.captureCharFrame();
      }
      const rows = frame.split("\n").map((row) => row.trimEnd());
      expect(rows[0]).toBe("estimates from local logs, upper bounds, never quota");
      expect(rows.some((row) => row.startsWith("● claude main"))).toBe(true);
      expect(rows.filter((row) => row !== "").length).toBeLessThanOrEqual(24);
      setup.renderer.keyInput.processParsedKey({
        name: "q",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "q",
        number: false,
        raw: "q",
        eventType: "press",
        source: "raw",
      });
      await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("5 seconds")));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("paints the session rows as soon as a first read that outlasted its patience lands, ending scanning without waiting for the next refresh", async () => {
    const { promise: herdrHeld, resolve: releaseHerdr } = Promise.withResolvers<void>();
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedReads(Effect.promise(() => herdrHeld)))));
    const frameOnce = async (shows: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await Bun.sleep(25);
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        if (frame.includes(shows)) return frame;
      }
      return setup.captureCharFrame();
    };
    try {
      expect(await frameOnce("reading local session logs…")).toContain("reading local session logs…");
      releaseHerdr();
      expect(await frameOnce("claude main")).toContain("claude main");
    } finally {
      releaseHerdr();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  // The read is interrupted, not left on a detached fiber, so a herdr call cannot outlive the panel.
  test("interrupts a first read still in flight when the quit key is pressed", async () => {
    let herdrInterrupted = false;
    const herdrNever = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (herdrInterrupted = true))));
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedReads(herdrNever))));
    try {
      for (let attempt = 0; attempt < 200 && !setup.captureCharFrame().includes("reading local session logs…"); attempt += 1) {
        await Bun.sleep(25);
        await setup.renderOnce();
      }
      expect(setup.captureCharFrame()).toContain("reading local session logs…");
      setup.renderer.keyInput.processParsedKey({
        name: "q",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "q",
        number: false,
        raw: "q",
        eventType: "press",
        source: "raw",
      });
      await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("5 seconds")));
      expect(herdrInterrupted).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);
});
