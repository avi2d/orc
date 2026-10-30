import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect";
import {
  type CiRun,
  CiRuns,
  ciRunsLayer,
  CommandRunner,
  CommandUnreachable,
  decodeCiJobs,
  decodePueue,
  decodeRunnerRepos,
  jobSpan,
  machineQueue,
  pueueView,
  runnerReposLayer,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const iso = (instant: DateTime.Utc | undefined) => (instant === undefined ? undefined : DateTime.formatIso(instant));

const byteOrderMark = "\uFEFF";

const runnerFile = (agentName: string, gitHubUrl: string) =>
  `${byteOrderMark}${JSON.stringify({ agentId: 1, agentName, poolId: 1, gitHubUrl, workFolder: "_work" }, null, 2)}`;

describe("the repositories with a runner", () => {
  test("are each repository a runner is registered to, once, in order", () => {
    const stdout = [
      runnerFile("north-1", "https://github.com/example/shop"),
      runnerFile("north-2", "https://github.com/example/shop"),
      runnerFile("north-3", "https://github.com/example/blog"),
      runnerFile("north-4", "https://github.com/example-org"),
    ].join("");
    expect(valueOf(decodeRunnerRepos(stdout))).toEqual(["example/blog", "example/shop"]);
  });

  const broken: ReadonlyArray<readonly [string, string]> = [
    ["text outside an object", `${runnerFile("north-1", "https://github.com/example/shop")} done`],
    ["an object left open", `{"agentName": "north-1", "gitHubUrl": "https://github.com/example/shop"`],
    ["a brace never opened", "}"],
  ];
  for (const [what, stdout] of broken) {
    test(`are not read from ${what}`, () => {
      expect(issueOf(decodeRunnerRepos(stdout))).toContain("runner file");
    });
  }

  test("keep a brace inside a quoted value", () => {
    expect(valueOf(decodeRunnerRepos(runnerFile("north-{1}", "https://github.com/example/shop")))).toEqual(["example/shop"]);
  });
});

const job = (runner: string | null, started: string | null, completed: string | null) => ({
  runner_name: runner,
  started_at: started,
  completed_at: completed,
  status: completed === null ? "in_progress" : "completed",
});

describe("the span of a run's jobs", () => {
  test("runs from the first start to the last end of the jobs a runner took", () => {
    const jobs = valueOf(
      decodeCiJobs(
        JSON.stringify({
          jobs: [
            job("north-1", "2026-10-20T10:01:00Z", "2026-10-20T10:03:00Z"),
            job("north-2", "2026-10-20T10:02:00Z", "2026-10-20T10:06:00Z"),
            job(null, "2026-10-20T09:00:00Z", "2026-10-20T12:00:00Z"),
          ],
        }),
      ),
    );
    const span = jobSpan(jobs);
    expect([iso(span?.startedAt), iso(span?.endedAt)]).toEqual(["2026-10-20T10:01:00.000Z", "2026-10-20T10:06:00.000Z"]);
  });

  test("has no end while a job runs", () => {
    const jobs = valueOf(
      decodeCiJobs(JSON.stringify({ jobs: [job("north-1", "2026-10-20T10:01:00Z", "2026-10-20T10:03:00Z"), job("north-2", "2026-10-20T10:02:00Z", null)] })),
    );
    expect(jobSpan(jobs)?.endedAt).toBeUndefined();
  });

  test("is none when no runner took a job", () => {
    expect(jobSpan(valueOf(decodeCiJobs(JSON.stringify({ jobs: [job(null, null, null)] }))))).toBeUndefined();
  });
});

const run = (id: number, status: string, conclusion: string | null) => ({
  id,
  name: "ci",
  head_branch: "main",
  status,
  conclusion,
  created_at: "2026-10-20T09:00:00Z",
  updated_at: "2026-10-20T09:10:00Z",
});

const runnersCommand = "cat /srv/runners/*/.runner";

const answer = (argv: ReadonlyArray<string>): Effect.Effect<string, CommandUnreachable> => {
  const line = argv.join(" ");
  if (line === `sh -c ${runnersCommand}`) return Effect.succeed(runnerFile("north-1", "https://github.com/example/shop") + runnerFile("north-2", "https://github.com/example/blog"));
  if (line.startsWith("gh api repos/example/blog/actions/runs?")) return Effect.fail(new CommandUnreachable({ reason: "gh api answered 502" }));
  if (line.startsWith("gh api repos/example/shop/actions/runs?")) return Effect.succeed(JSON.stringify({ workflow_runs: [run(7, "completed", "success"), run(8, "in_progress", null)] }));
  if (line.startsWith("gh api repos/example/shop/actions/runs/7/jobs")) return Effect.succeed(JSON.stringify({ jobs: [job("north-1", "2026-10-20T09:02:00Z", "2026-10-20T09:05:00Z")] }));
  if (line.startsWith("gh api repos/example/shop/actions/runs/8/jobs")) return Effect.succeed(JSON.stringify({ jobs: [job("north-1", "2026-10-20T09:04:00Z", null)] }));
  return Effect.fail(new CommandUnreachable({ reason: `unexpected ${line}` }));
};

const ciRunsWith = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ci = yield* CiRuns;
      return Option.isSome(ci) ? Option.some(yield* ci.value.read) : Option.none();
    }).pipe(
      Effect.provide(
        ciRunsLayer.pipe(
          Layer.provideMerge(runnerReposLayer),
          Layer.provide(Layer.succeed(CommandRunner, { run: (command) => answer(command.argv) })),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      ),
    ),
  );

describe("the CI runs of the repositories with a runner", () => {
  test("are each repository's runs with their job spans, naming a repository GitHub did not answer for", async () => {
    const read = await ciRunsWith({ TUI_DASH_RUNNERS: runnersCommand });
    const report = Option.isSome(read) ? valueOf(read.value) : undefined;
    expect(report?.repos).toEqual(["example/blog", "example/shop"]);
    expect(report?.runs.map((each) => [each.id, each.status, iso(each.jobs?.startedAt), iso(each.jobs?.endedAt)])).toEqual([
      [7, "done", "2026-10-20T09:02:00.000Z", "2026-10-20T09:05:00.000Z"],
      [8, "running", "2026-10-20T09:04:00.000Z", undefined],
    ]);
    expect(report?.failures.map((failure) => [failure.repo, failure.failure.kind])).toEqual([["example/blog", "unreachable"]]);
  });

  test("are not read when no runner command is set", async () => {
    expect(Option.isNone(await ciRunsWith({}))).toBe(true);
  });
});

const ciRun = (overrides: Partial<CiRun>): CiRun => ({
  repo: "example/shop",
  id: 1,
  workflow: "ci",
  branch: "main",
  createdAt: at("2026-10-20T09:00:00Z"),
  updatedAt: at("2026-10-20T09:10:00Z"),
  status: "done",
  conclusion: "success",
  jobs: undefined,
  ...overrides,
});

describe("a machine's queue", () => {
  const pueue = pueueView(valueOf(decodePueue(fixture("pueue/status.json"))));
  const lastEnd = pueue.ended[0]?.endedAt ?? at("2026-10-13T18:21:00Z");
  const now = DateTime.addDuration(lastEnd, "1 hour");
  const ci = [
    ciRun({ id: 1, status: "waiting", conclusion: undefined }),
    ciRun({ id: 2, workflow: "sweep", conclusion: "timed_out", updatedAt: DateTime.addDuration(lastEnd, "10 minutes"), jobs: { startedAt: DateTime.addDuration(lastEnd, "5 minutes"), endedAt: DateTime.addDuration(lastEnd, "8 minutes") } }),
    ciRun({ id: 3, updatedAt: DateTime.subtractDuration(now, "25 hours") }),
  ];
  const queue = machineQueue([{ machine: "north", pueue, owners: new Map([[10, "shop-fix"]]) }], ci, now);

  test("lists what runs, then what waits, then what ended newest first, within the last day", () => {
    expect(queue.rows.map((row) => [row.kind, row.state])).toEqual([
      ["pueue", "running"],
      ["pueue", "running"],
      ["CI", "waiting"],
      ["CI", "failure"],
      ["pueue", "success"],
      ["pueue", "cancelled"],
      ["pueue", "failure"],
      ["pueue", "failure"],
      ["pueue", "success"],
      ["pueue", "failure"],
    ]);
  });

  test("takes how long a run took from its jobs", () => {
    expect(queue.rows.find((row) => row.where === "shop" && row.what === "sweep")?.tookSeconds).toBe(180);
  });

  test("counts the CI run waiting apart from pueue's two queued tasks", () => {
    expect([queue.running, queue.waiting, queue.queuedInPueue]).toEqual([2, 1, 2]);
  });

  test("names a pueue run by the task that started it", () => {
    expect(queue.rows.filter((row) => row.state === "running").map((row) => [row.where, row.what])).toEqual([
      ["unknown", "sleep 800"],
      ["shop-fix", "sleep 1000"],
    ]);
  });

  test("joins both machines' queues with a machine per row and the shared CI runs once", () => {
    const southStatus = valueOf(
      decodePueue(JSON.stringify({ tasks: { "7": { id: 7, command: "bun test", path: "/home/example/work/kelp", status: { Running: { start: lastEnd } } } }, groups: {} })),
    );
    const joined = machineQueue(
      [
        { machine: "north", pueue, owners: new Map() },
        { machine: "south", pueue: pueueView(southStatus), owners: new Map() },
      ],
      ci,
      now,
    );
    expect(joined.rows.slice(0, 4).map((row) => [row.kind, row.machine, row.state])).toEqual([
      ["pueue", "north", "running"],
      ["pueue", "north", "running"],
      ["pueue", "south", "running"],
      ["CI", undefined, "waiting"],
    ]);
    expect(joined.rows.filter((row) => row.kind === "CI")).toHaveLength(2);
    expect([joined.running, joined.waiting, joined.queuedInPueue]).toEqual([3, 1, 2]);
  });
});
