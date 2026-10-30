import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const front = (fields: ReadonlyArray<readonly [string, string]>): string =>
  ["---", ...fields.map(([key, value]) => key + ": " + value), "---", ""].join(String.fromCharCode(10));

const task = (
  id: string,
  title: string,
  project: string,
  machine: string | null,
  dependsOn: ReadonlyArray<string>,
  extra: ReadonlyArray<readonly [string, string]> = [],
): string =>
  front([
    ["id", JSON.stringify(id)],
    ["title", JSON.stringify(title)],
    ["project", JSON.stringify(project)],
    ["machine", machine === null ? "null" : JSON.stringify(machine)],
    ["depends_on", JSON.stringify(dependsOn)],
    ["created", JSON.stringify("2026-10-27T10:00:00.000Z")],
    ...extra,
  ]) + "# " + title + String.fromCharCode(10);

const claim: ReadonlyArray<readonly [string, string]> = [
  ["beat", JSON.stringify("beat-1")],
  ["taken_for", JSON.stringify("mac")],
  ["account", JSON.stringify("main")],
  ["taken_at", JSON.stringify("2026-10-27T10:01:00.000Z")],
];

const started: ReadonlyArray<readonly [string, string]> = [
  ["started_at", JSON.stringify("2026-10-27T10:02:00.000Z")],
  ["start_log", JSON.stringify("/tmp/task-6.log")],
];

// The one backlog every dispatch test reads: a full mac, a free linux, and one task for each way a new task waits.
export const writeDispatchBacklog = async (root: string): Promise<void> => {
  await mkdir(join(root, "new"), { recursive: true });
  await mkdir(join(root, "taken"), { recursive: true });
  await mkdir(join(root, "closed"), { recursive: true });
  await writeFile(
    join(root, "dispatch.json"),
    JSON.stringify({ machines: [{ name: "mac", slots: 1 }, { name: "linux", slots: 2 }] }),
  );
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      projects: [
        { name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } },
        { name: "docs", checkouts: { mac: "/Users/a/docs" } },
      ],
    }),
  );
  await writeFile(join(root, "new", "task-1.md"), task("task-1", "Free task", "orc", null, []));
  await writeFile(join(root, "new", "task-2.md"), task("task-2", "Blocked task", "orc", null, ["task-9"]));
  await writeFile(join(root, "new", "task-3.md"), task("task-3", "Unknown project", "site", null, []));
  await writeFile(join(root, "new", "task-4.md"), task("task-4", "Unknown machine", "orc", "feld", []));
  await writeFile(join(root, "new", "task-5.md"), task("task-5", "No checkout", "docs", "linux", []));
  await writeFile(join(root, "new", "task-7.md"), task("task-7", "Full machine", "orc", "mac", []));
  await writeFile(join(root, "new", "task-11.md"), "no frontmatter here" + String.fromCharCode(10));
  await writeFile(join(root, "taken", "task-6.md"), task("task-6", "Running task", "orc", null, [], claim));
  await writeFile(
    join(root, "closed", "task-8.md"),
    task("task-8", "Done task", "orc", null, [], [
      ...claim,
      ...started,
      ["outcome", JSON.stringify("done")],
      ["closed_at", JSON.stringify("2026-10-27T11:00:00.000Z")],
      ["reason", JSON.stringify("")],
    ]),
  );
  await writeFile(
    join(root, "closed", "task-10.md"),
    task("task-10", "Failed task", "orc", null, [], [
      ...claim,
      ...started,
      ["outcome", JSON.stringify("failed")],
      ["closed_at", JSON.stringify("2026-10-27T11:05:00.000Z")],
      ["reason", JSON.stringify("the run failed")],
    ]),
  );
};
