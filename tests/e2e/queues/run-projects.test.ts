import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import { readQueuesReport } from "@tui-dash/queues";
import { actionsSourceLayer, type Command, CommandRunner, CommandUnreachable, copyPathsOfStatus, decodePueue, pueueMachinesLayer, pueueView, type QueuesReport } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const recordedCopy = "/home/example/.no-mistakes/worktrees/0a1b2c3d4e5f/01EXAMPLERUN";

describe("the run copies in a recorded pueue status", () => {
  test("are task 5's copy alone", () => {
    expect(copyPathsOfStatus(valueOf(decodePueue(fixture("pueue/status.json"))))).toEqual([recordedCopy]);
  });

  test("show the project they were given rather than the run id", () => {
    const view = pueueView(valueOf(decodePueue(fixture("pueue/status.json"))), new Map([[recordedCopy, "website"]]));
    expect(view.running.map((row) => [row.id, row.project])).toContainEqual([5, "website"]);
  });
});

let root = "";

const copyOf = (hash: string, run: string) => join(root, ".no-mistakes", "worktrees", hash, run);

const git = (...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", ...args]);
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${ran.stderr.toString()}`);
};

const withOrigin = (repository: string, origin: string, ...init: ReadonlyArray<string>) => {
  mkdirSync(repository, { recursive: true });
  git("init", "-q", ...init, repository);
  git("-C", repository, "remote", "add", "origin", origin);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "run-projects-"));
  withOrigin(copyOf("aaa", "01LIVE"), "https://github.com/example/harbor.git");
  withOrigin(join(root, ".no-mistakes", "repos", "bbb.git"), "git@github.com:example/notes.git", "--bare");
  withOrigin(copyOf("ccc", "it's $(echo elsewhere) run"), "ssh://git@github.com/example/beacon.git");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const copies = () => [copyOf("aaa", "01LIVE"), copyOf("bbb", "01FINISHED"), copyOf("ccc", "it's $(echo elsewhere) run"), copyOf("ddd", "01NOREPO")];

const runningTask = (id: number, path: string) => ({
  id,
  created_at: "2026-10-18T03:23:09.596033377+03:00",
  original_command: "sleep 800",
  command: "sleep 800",
  path,
  envs: {},
  group: "default",
  dependencies: [],
  priority: 0,
  label: null,
  status: { Running: { enqueued_at: "2026-10-18T03:23:09.596031884+03:00", start: "2026-10-18T03:23:09.846904817+03:00" } },
});

const statusOf = (paths: ReadonlyArray<string>): string =>
  JSON.stringify({
    tasks: Object.fromEntries(paths.map((path, id) => [String(id), runningTask(id, path)])),
    groups: { default: { status: "Running", parallel_tasks: 4 } },
  });

interface Shell {
  readonly asked: Array<string>;
  dropNext: boolean;
}

// Every shell line runs for real, so git reads the origins the scratch repositories were given.
const sourcesOf = (remote: string, shell: Shell) =>
  Layer.mergeAll(pueueMachinesLayer, actionsSourceLayer).pipe(
    Layer.provide(
      Layer.succeed(CommandRunner, {
        run: (command: Command) => {
          const line = command.argv.join(" ");
          if (line.includes("pueue status")) return Effect.succeed(statusOf(copies()));
          if (command.argv[0] !== "sh") return Effect.fail(new CommandUnreachable({ reason: "not recorded" }));
          shell.asked.push(line);
          if (shell.dropNext) {
            shell.dropNext = false;
            return Effect.fail(new CommandUnreachable({ reason: "ssh exited 255" }));
          }
          const ran = Bun.spawnSync([...command.argv]);
          return ran.exitCode === 0 ? Effect.succeed(ran.stdout.toString()) : Effect.fail(new CommandUnreachable({ reason: `sh exited ${ran.exitCode}` }));
        },
      }),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_PUEUE: remote }))),
  );

const projectsOn = (report: QueuesReport, machine: string) => {
  const pueue = report.machines.find((read) => read.name === machine)?.pueue;
  return pueue?.kind === "ok" ? pueue.value.running.map((row) => row.project) : [];
};

const reportsOf = (remote: string, shell: Shell, reads: number) =>
  Effect.runPromise(Effect.provide(Effect.replicateEffect(readQueuesReport, reads), sourcesOf(remote, shell)));

// eval stands in for ssh: both join the rest of the line and hand it to another shell, which parses it again.
const throughAnotherShell = "eval pueue status --json";

describe("a no-mistakes run copy in the queue", () => {
  for (const remote of [throughAnotherShell, "eval 'pueue status --json'"]) {
    test(`shows the project its origin names, on this machine and through the other machine's shell, for ${remote}`, async () => {
      const [report] = await reportsOf(remote, { asked: [], dropNext: false }, 1);
      for (const machine of ["north", "south"]) {
        expect(projectsOn(report, machine)).toEqual(["harbor", "notes", "beacon", "unknown"]);
      }
    });
  }

  test("is read once for each machine, not on every read", async () => {
    const shell: Shell = { asked: [], dropNext: false };
    const reports = await reportsOf(throughAnotherShell, shell, 2);
    expect(reports.map((report) => projectsOn(report, "south"))).toEqual([
      ["harbor", "notes", "beacon", "unknown"],
      ["harbor", "notes", "beacon", "unknown"],
    ]);
    expect(shell.asked).toHaveLength(2);
  });

  test("is asked again after the connection drops, rather than kept as unknown", async () => {
    const shell: Shell = { asked: [], dropNext: true };
    const [first, second] = await reportsOf(throughAnotherShell, shell, 2);
    expect([first, second].map((report) => projectsOn(report, "north").length + projectsOn(report, "south").length)).toEqual([8, 8]);
    expect([...projectsOn(first, "north"), ...projectsOn(first, "south")]).toContain("unknown");
    expect([projectsOn(second, "north"), projectsOn(second, "south")]).toEqual([
      ["harbor", "notes", "beacon", "unknown"],
      ["harbor", "notes", "beacon", "unknown"],
    ]);
  });

  for (const remote of ["pueue status --json", "eval ~/.cargo/bin/pueue status --json", "eval 'cd /tmp && pueue status --json'"]) {
    test(`says unknown on the other machine and asks no shell for it when its command is ${remote}`, async () => {
      const shell: Shell = { asked: [], dropNext: false };
      const reports = await reportsOf(remote, shell, 2);
      for (const report of reports) {
        expect(projectsOn(report, "south")).toEqual(["unknown", "unknown", "unknown", "unknown"]);
        expect(projectsOn(report, "north")).toEqual(["harbor", "notes", "beacon", "unknown"]);
      }
      expect(shell.asked).toHaveLength(1);
    });
  }
});
