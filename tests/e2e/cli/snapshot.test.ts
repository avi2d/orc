import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Schema } from "effect";
import { SnapshotReport } from "@tui-dash/schema";

const root = join(import.meta.dir, "..", "..", "..");

const command = join(root, "packages", "cli", "src", "bin.ts");

const recordedTasks = join(root, "tests", "fixtures", "tasks", "east.json");

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const tuiDash = async (args: ReadonlyArray<string>, extra: Readonly<Record<string, string>> = {}): Promise<Ran> => {
  const child = Bun.spawn(["bun", command, ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...extra },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

describe("tui-dash snapshot --json", () => {
  test("prints the selected source, with this machine's tasks and the other machine's failure", async () => {
    const ran = await tuiDash(["snapshot", "--json", "--only", "tasks"], {
      TUI_DASH_MACHINE: "north",
      TUI_DASH_REMOTE_MACHINE: "south",
      TUI_DASH_TASKS: `cat '${recordedTasks}'`,
      TUI_DASH_REMOTE_TASKS: "echo 'south.example.com refused the connection' >&2; exit 255",
    });
    expect(ran.code).toBe(0);
    const report = Schema.decodeUnknownSync(SnapshotReport)(JSON.parse(ran.stdout));
    expect(report.machine).toBe("north");
    expect(Object.keys(report.sources)).toEqual(["tasks"]);
    const tasks = report.sources.tasks;
    if (tasks?.status !== "ok") throw new Error(`expected the tasks source to answer, got ${JSON.stringify(tasks)}`);
    expect(tasks.machines.map(({ name, reading }) => [name, reading.kind === "ok" ? reading.value.tasks.map(({ id }) => id) : reading])).toEqual([
      ["north", ["tasks-bridge-plot", "tasks-inbox-sweep", "tasks-release-notes"]],
      ["south", { kind: "unreachable", reason: "sh exited 255: south.example.com refused the connection" }],
    ]);
  });

  test("refuses a source it does not know and names it", async () => {
    const ran = await tuiDash(["snapshot", "--json", "--only", "tasks,load"]);
    expect(ran.code).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain('"load" is not one of them');
  });

  test("refuses to run without --json", async () => {
    const ran = await tuiDash(["snapshot"]);
    expect(ran.code).not.toBe(0);
    expect(ran.stdout + ran.stderr).toContain("--json");
  });
});
