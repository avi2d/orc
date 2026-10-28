import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, type Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  CommandRunner,
  CommandUnreachable,
  cronPattern,
  decodeAgents,
  decodePueue,
  decodeTimers,
  decodeWorkflowCrons,
  MachineSchedules,
  machineSchedulesLayer,
  nextMatch,
  nextUp,
  runnerReposLayer,
  type ScheduleRead,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const at = (iso: string) => DateTime.makeUnsafe(iso);

const iso = (instant: DateTime.Utc | undefined) => (instant === undefined ? undefined : DateTime.formatIso(instant));

const nextAfter = (expression: string, after: string, zone = utc) => {
  const pattern = cronPattern(expression);
  if (pattern === undefined) throw new Error(`${expression} did not parse`);
  return iso(nextMatch(pattern, at(after), zone));
};

describe("a cron line's next time", () => {
  // crontab(5): a step applies over the range before it, and both restricted day fields match on either.
  test("is the next Monday when the line names the 1st, the 15th and Mondays", () => {
    expect(nextAfter("0 0 1,15 * 1", "2026-10-20T00:30:00Z")).toBe("2026-10-26T00:00:00.000Z");
  });

  test("keeps a stepped week day field when the day field is *", () => {
    expect(nextAfter("0 9 * * */2", "2026-10-20T10:00:00Z")).toBe("2026-10-22T09:00:00.000Z");
  });

  test("steps minutes from the start of the range", () => {
    expect(nextAfter("10-50/20 * * * *", "2026-10-20T10:31:00Z")).toBe("2026-10-20T10:50:00.000Z");
  });

  test("is strictly after the time it starts from", () => {
    expect(nextAfter("30 10 * * *", "2026-10-20T10:30:00Z")).toBe("2026-10-21T10:30:00.000Z");
  });

  test("reads 7 in the week day field as Sunday", () => {
    expect(nextAfter("0 12 * * 7", "2026-10-20T00:00:00Z")).toBe("2026-10-25T12:00:00.000Z");
  });

  test("reads week day names in a range", () => {
    expect(nextAfter("0 9 * * MON-FRI", "2026-10-23T10:00:00Z")).toBe("2026-10-26T09:00:00.000Z");
  });

  test("reads week day names whatever their case", () => {
    expect(nextAfter("0 9 * * mon-fri", "2026-10-23T10:00:00Z")).toBe("2026-10-26T09:00:00.000Z");
  });

  test("reads SUN as Sunday", () => {
    expect(nextAfter("0 12 * * sun", "2026-10-20T00:00:00Z")).toBe("2026-10-25T12:00:00.000Z");
  });

  test("reads month names in a list", () => {
    expect(nextAfter("0 0 1 JAN,JUL *", "2026-10-20T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
  });

  test("leaves an unknown name unread", () => {
    expect(cronPattern("0 9 * * FUNDAY")).toBeUndefined();
  });

  test("follows the zone's clock across its change of hour", () => {
    const newYork = DateTime.zoneMakeNamedUnsafe("America/New_York");
    expect(nextAfter("30 6 * * *", "2026-10-20T12:00:00Z", newYork)).toBe("2026-10-21T10:30:00.000Z");
    expect(nextAfter("30 6 * * *", "2026-11-01T12:00:00Z", newYork)).toBe("2026-11-02T11:30:00.000Z");
  });

  test("keeps the first hour of the day after the clocks go forward", () => {
    expect(nextAfter("30 0 * * 1", "2027-03-10T12:00:00Z", DateTime.zoneMakeNamedUnsafe("America/New_York"))).toBe("2027-03-15T04:30:00.000Z");
    expect(nextAfter("30 0 * * 1", "2027-03-24T12:00:00Z", DateTime.zoneMakeNamedUnsafe("Europe/Berlin"))).toBe("2027-03-28T22:30:00.000Z");
  });

  test("is none for a date no year has", () => {
    expect(nextAfter("0 0 31 2 *", "2026-10-20T00:00:00Z")).toBeUndefined();
  });

  const unread = ["61 * * * *", "* * * *", "@daily", "1-2-3 * * * *", "*/0 * * * *", "5-1 * * * *"];
  for (const expression of unread) {
    test(`is not read from ${expression}`, () => {
      expect(cronPattern(expression)).toBeUndefined();
    });
  }
});

describe("the systemd timers", () => {
  // systemd.time(7): systemctl gives the next elapse in microseconds since the epoch, or 0 for none.
  test("are each named without the suffix, with the next elapse", () => {
    const timers = valueOf(
      decodeTimers(
        JSON.stringify([
          { unit: "backup.timer", next: 1792000000000000, activates: "backup.service" },
          { unit: "idle.timer", next: 0 },
          { unit: "never.timer", next: null },
          { unit: "bare.timer" },
        ]),
      ),
    );
    expect(timers.map((timer) => [timer.name, iso(timer.next)])).toEqual([
      ["backup", "2026-10-14T17:46:40.000Z"],
      ["idle", undefined],
      ["never", undefined],
      ["bare", undefined],
    ]);
  });
});

describe("the launch agents", () => {
  const plists = [
    { Label: "com.example.sync", StartCalendarInterval: [{ Hour: 9, Minute: 0 }, { Weekday: 7, Hour: 12, Minute: 15 }] },
    { Label: "com.example.poll", StartInterval: 300 },
    { Label: "com.example.off", Disabled: true, StartInterval: 60 },
    { Label: "com.example.daemon", KeepAlive: true },
  ]
    .map((plist) => JSON.stringify(plist))
    .join("\n");

  test("list each enabled agent that runs on a calendar or an interval", () => {
    const agents = valueOf(decodeAgents(plists));
    expect(agents.map((agent) => [agent.name, agent.calendar.length, agent.everySeconds])).toEqual([
      ["com.example.sync", 2, undefined],
      ["com.example.poll", 0, 300],
    ]);
  });

  // launchd.plist(5): 0 and 7 are both Sunday.
  test("read Weekday 7 as Sunday", () => {
    const sunday = valueOf(decodeAgents(plists)).at(0)?.calendar.at(1);
    expect(sunday === undefined ? undefined : iso(nextMatch(sunday, at("2026-10-20T00:00:00Z"), utc))).toBe("2026-10-25T12:15:00.000Z");
  });
});

const contentOf = (yaml: string) => JSON.stringify({ content: Buffer.from(yaml).toString("base64"), encoding: "base64" });

describe("a workflow file's schedules", () => {
  test("are each cron line, under the workflow's name", () => {
    const yaml = "name: nightly\non:\n  push:\n  schedule:\n    - cron: '0 3 * * *'\n    - cron: '@weekly'\n";
    const crons = valueOf(decodeWorkflowCrons("example/shop", ".github/workflows/nightly.yml")(contentOf(yaml)));
    expect(crons.map((cron) => [cron.name, cron.repo, cron.pattern === undefined])).toEqual([
      ["nightly", "example/shop", false],
      ["nightly", "example/shop", true],
    ]);
  });

  test("go by the file's name when the workflow has none", () => {
    const crons = valueOf(decodeWorkflowCrons("example/shop", ".github/workflows/sweep.yaml")(contentOf("on:\n  schedule:\n    - cron: '0 3 * * *'\n")));
    expect(crons.map((cron) => cron.name)).toEqual(["sweep"]);
  });

  test("reads a cron line that names its week days", () => {
    const yaml = "name: weekday\non:\n  schedule:\n    - cron: '0 9 * * MON-FRI'\n";
    const crons = valueOf(decodeWorkflowCrons("example/shop", ".github/workflows/weekday.yml")(contentOf(yaml)));
    expect(crons.map((cron) => [cron.name, cron.pattern === undefined])).toEqual([["weekday", false]]);
  });

  test("are none for a workflow run on push alone", () => {
    expect(valueOf(decodeWorkflowCrons("example/shop", ".github/workflows/ci.yml")(contentOf("name: ci\non: [push, pull_request]\n")))).toEqual([]);
  });
});

const runnersCommand = "cat /srv/runners/*/.runner";

const repoOf = (line: string): string | undefined => /^gh api repos\/([^/]+\/[^/]+)\//u.exec(line)?.at(1);

const nightly = "name: nightly\non:\n  schedule:\n    - cron: '0 3 * * *'\n";

const answer = (line: string): Effect.Effect<string, CommandUnreachable> => {
  if (line === `sh -c ${runnersCommand}`) return Effect.succeed(["shop", "blog"].map((repo) => JSON.stringify({ agentName: repo, gitHubUrl: `https://github.com/example/${repo}` })).join(""));
  if (line.startsWith("systemctl")) return Effect.succeed("[]");
  if (line === "gh api repos/example/blog/contents/.github/workflows") return Effect.fail(new CommandUnreachable({ reason: "gh api answered 404" }));
  if (line.includes("/actions/workflows")) return Effect.succeed(JSON.stringify({ workflows: [{ path: ".github/workflows/nightly.yml", state: "active" }] }));
  if (line === "gh api repos/example/shop/contents/.github/workflows") return Effect.succeed(JSON.stringify([{ path: ".github/workflows/nightly.yml", type: "file" }]));
  if (line === "gh api repos/example/shop/contents/.github/workflows/nightly.yml") return Effect.succeed(contentOf(nightly));
  return Effect.fail(new CommandUnreachable({ reason: `unexpected ${line}` }));
};

interface Paint {
  readonly calls: Readonly<Record<string, number>>;
  readonly crons: ReadonlyArray<string>;
  readonly unread: ReadonlyArray<string>;
}

const paintsAfter = (waits: ReadonlyArray<Duration.Input>): Promise<ReadonlyArray<Paint>> => {
  const calls: Record<string, number> = {};
  return Effect.runPromise(
    Effect.gen(function* () {
      const schedules = yield* MachineSchedules;
      const paints: Array<Paint> = [];
      for (const wait of waits) {
        yield* TestClock.adjust(wait);
        const ci = (yield* schedules.read).find((read) => read.source === "CI");
        const crons = ci?.outcome.kind === "ok" ? ci.outcome.value.flatMap((schedule) => (schedule.kind === "CI" ? [`${schedule.repo} ${schedule.name}`] : [])) : [];
        paints.push({ calls: { ...calls }, crons, unread: ci?.unread.map((failure) => failure.repo) ?? [] });
      }
      return paints;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          machineSchedulesLayer("linux").pipe(
            Layer.provideMerge(runnerReposLayer),
            Layer.provide(
              Layer.succeed(CommandRunner, {
                run: (command) => {
                  const line = command.argv.join(" ");
                  const repo = repoOf(line);
                  if (repo !== undefined) calls[repo] = (calls[repo] ?? 0) + 1;
                  return answer(line);
                },
              }),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_RUNNERS: runnersCommand }))),
          ),
          TestClock.layer(),
        ),
      ),
    ),
  );
};

describe("the scheduled workflows over time", () => {
  test("keep each repository's good read for an hour and try a failed one again after a minute", async () => {
    const paints = await paintsAfter(["0 seconds", "10 seconds", "51 seconds", "1 hour"]);
    expect(paints.map((paint) => paint.calls)).toEqual([
      { "example/shop": 3, "example/blog": 2 },
      { "example/shop": 3, "example/blog": 2 },
      { "example/shop": 3, "example/blog": 4 },
      { "example/shop": 6, "example/blog": 6 },
    ]);
    for (const paint of paints) expect([paint.crons, paint.unread]).toEqual([["example/shop nightly"], ["example/blog"]]);
  });
});

const now = at("2026-10-20T10:00:00Z");

const cron = (repo: string, name: string, expression: string) => ({ kind: "CI" as const, name, repo, pattern: cronPattern(expression) });

const schedules: ReadonlyArray<ScheduleRead> = [
  { source: "timer", outcome: { kind: "ok", value: [{ kind: "timer", name: "backup", next: at("2026-10-20T10:05:00Z") }] }, unread: [] },
  {
    source: "CI",
    outcome: {
      kind: "ok",
      value: [cron("example/shop", "release", "0 12 * * *"), cron("example/notes", "release", "0 12 * * *"), cron("example/shop", "sweep", "0 11 * * *")],
    },
    unread: [{ repo: "example/blog", failure: { kind: "unreachable", reason: "gh api answered 502" } }],
  },
];

const delayed = decodePueue(fixture("pueue/status.json").replace('"enqueue_at": null', '"enqueue_at": "2026-10-20T10:30:00Z"'));

describe("the next list", () => {
  const berlin = DateTime.zoneMakeNamedUnsafe("Europe/Berlin");
  const next = nextUp({
    schedules,
    pueues: [{ machine: "north", status: delayed }],
    orchestrators: [{ machine: "north", read: {
      kind: "ok",
      value: [
        { name: "weekly review", at: at("2026-10-21T08:00:00Z"), detail: "" },
        { name: "past review", at: at("2026-10-19T08:00:00Z"), detail: "" },
      ],
    } }],
    local: "north",
    now,
    zone: berlin,
  });

  test("lists every source's next time soonest first, one row for a workflow due at once in two repos", () => {
    expect(next.rows.map((row) => [row.kind, row.what, iso(row.at)])).toEqual([
      ["timer", "backup", "2026-10-20T10:05:00.000Z"],
      ["pueue", "~ echo stashed", "2026-10-20T10:30:00.000Z"],
      ["CI", "shop sweep", "2026-10-20T11:00:00.000Z"],
      ["CI", "release in 2 repos", "2026-10-20T12:00:00.000Z"],
      ["task", "weekly review", "2026-10-21T08:00:00.000Z"],
    ]);
  });

  test("times a workflow whose cron names its week days", () => {
    const named: ReadonlyArray<ScheduleRead> = [
      { source: "CI", outcome: { kind: "ok", value: [cron("example/shop", "standup", "0 9 * * MON-FRI")] }, unread: [] },
    ];
    const rows = nextUp({ schedules: named, pueues: [{ machine: "north", status: undefined }], orchestrators: [{ machine: "north", read: "absent" }], local: "north", now, zone: berlin }).rows;
    expect(rows.map((row) => [row.what, iso(row.at)])).toEqual([["shop standup", "2026-10-21T09:00:00.000Z"]]);
  });

  test("names the repository it could not read", () => {
    expect(next.sources.find((source) => source.kind === "CI")?.unread.map((failure) => failure.repo)).toEqual(["example/blog"]);
  });

  test("says which sources are still on their first read", () => {
    const first = nextUp({ schedules: undefined, pueues: [{ machine: "north", status: undefined }], orchestrators: [{ machine: "north", read: "pending" }], local: "north", now, zone: berlin });
    expect([first.pending, first.sources.map((source) => [source.kind, source.state.kind])]).toEqual([
      true,
      [
        ["pueue", "pending"],
        ["task", "pending"],
      ],
    ]);
  });

  test("leaves out the orchestrator's source when none is configured", () => {
    expect(nextUp({ schedules: [], pueues: [{ machine: "north", status: undefined }], orchestrators: [{ machine: "north", read: "absent" }], local: "north", now, zone: berlin }).sources.map((source) => source.kind)).toEqual(["pueue"]);
  });

  test("joins both machines' delayed jobs and dated items soonest first", () => {
    const stashed = (id: number, path: string, when: string) =>
      decodePueue(JSON.stringify({ tasks: { [id]: { id, command: "bun test", path, status: { Stashed: { enqueue_at: when } } } }, groups: {} }));
    const joined = nextUp({
      schedules: [],
      pueues: [{ machine: "north", status: stashed(3, "/home/example/work/harbor", "2026-10-20T10:30:00Z") }, { machine: "south", status: stashed(7, "/home/example/work/kelp", "2026-10-20T10:20:00Z") }],
      orchestrators: [
        { machine: "north", read: { kind: "ok", value: [{ name: "weekly review", at: at("2026-10-20T10:25:00Z"), detail: "" }] } },
        { machine: "south", read: { kind: "ok", value: [{ name: "kelp retro", at: at("2026-10-20T10:15:00Z"), detail: "" }] } },
      ],
      local: "north",
      now,
      zone: berlin,
    });
    expect(joined.rows.map((row) => [row.kind, row.machine, row.what])).toEqual([
      ["task", "south", "kelp retro"],
      ["pueue", "south", "kelp bun test"],
      ["task", "north", "weekly review"],
      ["pueue", "north", "harbor bun test"],
    ]);
    expect(joined.sources.map((source) => [source.kind, source.state.kind])).toEqual([
      ["pueue", "listed"],
      ["task", "listed"],
    ]);
  });

  test("keeps the answered machine's delayed jobs while the other machine is still reading", () => {
    const stashed = decodePueue(
      JSON.stringify({ tasks: { "3": { id: 3, command: "bun test", path: "/home/example/work/harbor", status: { Stashed: { enqueue_at: "2026-10-20T10:30:00Z" } } } }, groups: {} }),
    );
    const joined = nextUp({ schedules: [], pueues: [{ machine: "north", status: stashed }, { machine: "south", status: undefined }], orchestrators: [{ machine: "north", read: "absent" }], local: "north", now, zone: berlin });
    expect(joined.rows.map((row) => row.what)).toEqual(["harbor bun test"]);
    expect(joined.sources.map((source) => [source.kind, source.state.kind])).toEqual([["pueue", "pending"]]);
  });

  test("leaves a vendor updater out of the user's schedules", () => {
    const updater = nextUp({
      schedules: [
        {
          source: "agent",
          outcome: { kind: "ok", value: [{ kind: "agent", name: "com.google.GoogleUpdater.wake", calendar: [], everySeconds: 3600 }] },
          unread: [],
        },
      ],
      pueues: [{ machine: "north", status: decodePueue(JSON.stringify({ tasks: {}, groups: {} })) }],
      orchestrators: [{ machine: "north", read: { kind: "ok", value: [] } }],
      local: "north",
      now,
      zone: berlin,
    });
    expect(updater.rows).toEqual([]);
    expect(updater.sources.map((source) => [source.kind, source.state.kind])).toEqual([
      ["agent", "empty"],
      ["pueue", "empty"],
      ["task", "empty"],
    ]);
  });

  test("keeps the user's own launch agent while the vendor updater leaves", () => {
    const agents = nextUp({
      schedules: [
        {
          source: "agent",
          outcome: {
            kind: "ok",
            value: [
              { kind: "agent", name: "org.nix-community.home.backup", calendar: [], everySeconds: 3600 },
              { kind: "agent", name: "com.apple.SoftwareUpdate", calendar: [], everySeconds: 3600 },
            ],
          },
          unread: [],
        },
      ],
      pueues: [{ machine: "north", status: undefined }],
      orchestrators: [{ machine: "north", read: "absent" }],
      local: "north",
      now,
      zone: berlin,
    });
    expect(agents.rows.map((row) => row.what)).toEqual(["org.nix-community.home.backup"]);
  });

  test("names each failed machine while the answered machine\u2019s delayed jobs stay", () => {
    const stashed = decodePueue(
      JSON.stringify({ tasks: { "3": { id: 3, command: "bun test", path: "/home/example/work/harbor", status: { Stashed: { enqueue_at: "2026-10-20T10:30:00Z" } } } }, groups: {} }),
    );
    const down = { kind: "unreachable" as const, reason: "daemon down" };
    const mixed = nextUp({
      schedules: [],
      pueues: [
        { machine: "north", status: stashed },
        { machine: "south", status: down },
      ],
      orchestrators: [{ machine: "north", read: "absent" }],
      local: "north",
      now,
      zone: berlin,
    });
    expect(mixed.rows.map((row) => row.what)).toEqual(["harbor bun test"]);
    expect(mixed.sources.filter((source) => source.kind === "pueue").map((source) => [source.machine, source.state.kind])).toEqual([["south", "unreachable"]]);
    const both = nextUp({
      schedules: [],
      pueues: [
        { machine: "north", status: down },
        { machine: "south", status: down },
      ],
      orchestrators: [{ machine: "north", read: "absent" }],
      local: "north",
      now,
      zone: berlin,
    });
    expect(both.rows).toEqual([]);
    expect(both.sources.filter((source) => source.kind === "pueue").map((source) => [source.machine, source.state.kind])).toEqual([
      ["north", "unreachable"],
      ["south", "unreachable"],
    ]);
  });

  test("names the failed machine\u2019s dated items while the answered machine\u2019s dated item stays", () => {
    const dated = nextUp({
      schedules: [],
      pueues: [{ machine: "north", status: decodePueue(JSON.stringify({ tasks: {}, groups: {} })) }],
      orchestrators: [
        { machine: "north", read: { kind: "ok", value: [{ name: "weekly review", at: at("2026-10-20T10:25:00Z"), detail: "" }] } },
        { machine: "south", read: { kind: "invalid" as const, issue: "bad yaml" } },
      ],
      local: "north",
      now,
      zone: berlin,
    });
    expect(dated.rows.map((row) => row.what)).toEqual(["weekly review"]);
    expect(dated.sources.filter((source) => source.kind === "task").map((source) => [source.machine, source.state.kind])).toEqual([["south", "invalid"]]);
  });

  test("names the other machine\u2019s dated-items failure when this machine has no tasks report", () => {
    const dated = nextUp({
      schedules: [],
      pueues: [{ machine: "north", status: decodePueue(JSON.stringify({ tasks: {}, groups: {} })) }],
      orchestrators: [
        { machine: "north", read: "absent" },
        { machine: "south", read: { kind: "invalid" as const, issue: "bad yaml" } },
      ],
      local: "north",
      now,
      zone: berlin,
    });
    expect(dated.sources.filter((source) => source.kind === "task").map((source) => [source.machine, source.state.kind])).toEqual([["south", "invalid"]]);
  });

  test("marks local timer and agent rows with this machine and leaves shared CI rows blank", () => {
    const stashed = decodePueue(
      JSON.stringify({ tasks: { "3": { id: 3, command: "bun test", path: "/home/example/work/harbor", status: { Stashed: { enqueue_at: "2026-10-20T10:30:00Z" } } } }, groups: {} }),
    );
    const rows = nextUp({
      schedules: [
        { source: "timer", outcome: { kind: "ok", value: [{ kind: "timer", name: "backup", next: at("2026-10-20T10:35:00Z") }] }, unread: [] },
        { source: "agent", outcome: { kind: "ok", value: [{ kind: "agent", name: "local.backup", calendar: [], everySeconds: 3600 }] }, unread: [] },
        {
          source: "CI",
          outcome: { kind: "ok", value: [{ kind: "CI", name: "nightly", repo: "example/shop", pattern: undefined }] },
          unread: [],
        },
      ],
      pueues: [
        { machine: "north", status: stashed },
        { machine: "south", status: stashed },
      ],
      orchestrators: [{ machine: "north", read: "absent" }],
      local: "north",
      now,
      zone: berlin,
    }).rows;
    expect(rows.filter((row) => row.kind === "timer").map((row) => row.machine)).toEqual(["north"]);
    expect(rows.filter((row) => row.kind === "agent").map((row) => row.machine)).toEqual(["north"]);
    expect(rows.filter((row) => row.kind === "CI").map((row) => row.machine)).toEqual([undefined]);
  });
});
